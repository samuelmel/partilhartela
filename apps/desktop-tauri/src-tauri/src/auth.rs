// Login com Discord (OAuth2 + PKCE) e links partilhartela://. O Rust abre o navegador e recebe o
// `code` pelo loopback (127.0.0.1:53134) ou, se a porta estiver ocupada, pelo protocolo
// partilhartela://auth/callback. A troca do code pela sessão é feita pela webview no servidor, que
// guarda o client secret. A sessão fica cifrada com o DPAPI do Windows (equivalente ao safeStorage).

use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use url::Url;

const LOOPBACK_PORT: u16 = 53134;
const LOOPBACK_REDIRECT: &str = "http://127.0.0.1:53134/callback";
const PROTOCOL_REDIRECT: &str = "partilhartela://auth/callback";
const TIMEOUT: Duration = Duration::from_secs(5 * 60);

struct Pending {
    state: String,
    tx: oneshot::Sender<Result<String, String>>,
}

#[derive(Default)]
pub struct AuthState {
    pending: Mutex<Option<Pending>>,
    pending_join: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeResult {
    code: String,
    code_verifier: String,
    redirect_uri: String,
}

fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

fn valid_code(code: &str) -> bool {
    (10..=200).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Resposta do Discord (loopback ou protocolo). Ignora o que não bate com o `state` pendente.
/// Devolve `true` quando era o login concluído com sucesso.
fn handle_callback(state: &AuthState, query: &[(String, String)]) -> bool {
    let get = |name: &str| query.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
    let mut guard = state.pending.lock().unwrap();
    if guard.as_ref().map(|p| Some(&p.state) == get("state").as_ref()) != Some(true) {
        return false;
    }
    let pending = guard.take().unwrap();
    drop(guard);
    let result = if let Some(error) = get("error") {
        Err(if error == "access_denied" {
            "Login com Discord cancelado.".to_owned()
        } else {
            format!("O Discord recusou o login ({error}).")
        })
    } else if let Some(code) = get("code").filter(|code| valid_code(code)) {
        Ok(code)
    } else {
        Err("O Discord não devolveu um código de login válido.".to_owned())
    };
    let ok = result.is_ok();
    let _ = pending.tx.send(result);
    ok
}

fn done_page(ok: bool) -> String {
    let text = if ok {
        "Login concluído. Pode voltar ao PartilharTela."
    } else {
        "Login não concluído. Volte ao PartilharTela e tente de novo."
    };
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>PartilharTela</title>\
         <body style=\"font-family:system-ui;background:#1b1c20;color:#ececf1;display:grid;place-items:center;min-height:100vh;margin:0\">\
         <p>{text}</p></body>"
    )
}

async fn serve_loopback(app: AppHandle, listener: TcpListener) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { return };
        let mut buffer = vec![0u8; 8192];
        let read = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer)).await {
            Ok(Ok(read)) => read,
            _ => continue,
        };
        let request = String::from_utf8_lossy(&buffer[..read]);
        let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("/");
        let parsed = Url::parse(&format!("http://127.0.0.1{target}"));
        let (status, body) = match parsed {
            Ok(url) if url.path() == "/callback" => {
                let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                let state = app.state::<AuthState>();
                let ok = handle_callback(&state, &query) && query.iter().any(|(key, _)| key == "code");
                ("200 OK", done_page(ok))
            }
            _ => ("404 Not Found", String::new()),
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }
}

#[tauri::command]
pub async fn authorize_discord(app: AppHandle, state: State<'_, AuthState>, client_id: String) -> Result<AuthorizeResult, String> {
    if !(15..=22).contains(&client_id.len()) || !client_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("O servidor não informou um Client ID do Discord válido.".to_owned());
    }

    let code_verifier = random_token(48);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let oauth_state = random_token(24);
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state.pending.lock().unwrap();
        if let Some(old) = pending.take() {
            let _ = old.tx.send(Err("Login substituído por uma nova tentativa.".to_owned()));
        }
        *pending = Some(Pending { state: oauth_state.clone(), tx });
    }

    let listener = TcpListener::bind(("127.0.0.1", LOOPBACK_PORT)).await.ok();
    let redirect_uri = if listener.is_some() { LOOPBACK_REDIRECT } else { PROTOCOL_REDIRECT };
    let server = listener.map(|listener| tauri::async_runtime::spawn(serve_loopback(app.clone(), listener)));

    let mut authorize = Url::parse("https://discord.com/oauth2/authorize").map_err(|e| e.to_string())?;
    authorize
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("scope", "identify")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", &oauth_state)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "none");

    let outcome = if app.opener().open_url(authorize.as_str(), None::<&str>).is_err() {
        Err("Não foi possível abrir o navegador para o login.".to_owned())
    } else {
        match tokio::time::timeout(TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Login substituído por uma nova tentativa.".to_owned()),
            Err(_) => Err("O login com Discord não foi concluído a tempo.".to_owned()),
        }
    };

    // Limpa o pendente (se ainda for este) e fecha o loopback.
    {
        let mut pending = state.pending.lock().unwrap();
        if pending.as_ref().map(|p| p.state == oauth_state) == Some(true) {
            *pending = None;
        }
    }
    if let Some(server) = server {
        server.abort();
    }

    outcome.map(|code| AuthorizeResult { code, code_verifier, redirect_uri: redirect_uri.to_owned() })
}

// ---------- Links partilhartela:// ----------

/// `partilhartela://join/CODIGO` entra na sala; `partilhartela://auth/callback` conclui o login.
pub fn handle_deep_link(app: &AppHandle, link: &str) {
    let Ok(url) = Url::parse(link) else { return };
    if url.scheme() != "partilhartela" {
        return;
    }
    // Em URLs não especiais o "host" é o primeiro segmento: join, auth.
    let mut parts: Vec<String> = Vec::new();
    if let Some(host) = url.host_str() {
        parts.push(host.to_owned());
    }
    parts.extend(url.path().split('/').filter(|part| !part.is_empty()).map(str::to_owned));

    let state = app.state::<AuthState>();
    if parts.first().map(String::as_str) == Some("auth") && parts.get(1).map(String::as_str) == Some("callback") {
        let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        handle_callback(&state, &query);
        focus_main_window(app);
        return;
    }
    let code = (parts.first().map(String::as_str) == Some("join"))
        .then(|| parts.get(1).map(|code| code.to_uppercase()))
        .flatten()
        .filter(|code| code.len() == 6 && code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
    let Some(code) = code else { return };
    // Guarda e só avisa: a webview busca com consume_pending_join (também ao montar), sem corrida.
    *state.pending_join.lock().unwrap() = Some(code);
    focus_main_window(app);
    let _ = app.emit("deeplink:join", ());
}

pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn consume_pending_join(state: State<'_, AuthState>) -> Option<String> {
    state.pending_join.lock().unwrap().take()
}

// ---------- Sessão cifrada com o DPAPI ----------

fn session_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|_| "Não foi possível achar a pasta de dados do app.".to_owned())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Não foi possível criar a pasta de dados ({e})."))?;
    Ok(dir.join("discord-session.bin"))
}

mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let data = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
        unsafe { LocalFree(Some(HLOCAL(blob.pbData as *mut _))) };
        data
    }

    pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe { CryptProtectData(&input, None, None, None, None, 0, &mut output) }.ok()?;
        Some(take_blob(output))
    }

    pub fn unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: cipher.len() as u32, pbData: cipher.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe { CryptUnprotectData(&input, None, None, None, None, 0, &mut output) }.ok()?;
        Some(take_blob(output))
    }
}

#[tauri::command]
pub fn save_session(app: AppHandle, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 8192 {
        return Err("Sessão inválida.".to_owned());
    }
    let cipher = dpapi::protect(value.as_bytes()).ok_or(
        "Este computador não permite guardar a sessão com segurança; você vai precisar entrar de novo ao reabrir o app.",
    )?;
    std::fs::write(session_file(&app)?, cipher).map_err(|e| format!("Não foi possível salvar a sessão ({e})."))
}

#[tauri::command]
pub fn load_session(app: AppHandle) -> Option<String> {
    let cipher = std::fs::read(session_file(&app).ok()?).ok()?;
    String::from_utf8(dpapi::unprotect(&cipher)?).ok()
}

#[tauri::command]
pub fn clear_session(app: AppHandle) -> Result<(), String> {
    let path = session_file(&app)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Não foi possível apagar a sessão ({error}).")),
    }
}
