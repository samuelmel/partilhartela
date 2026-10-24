import { app, safeStorage, shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Login com Discord (OAuth2 + PKCE). O main abre o navegador e recebe o `code` pelo loopback
// (127.0.0.1:53134) ou, se a porta estiver ocupada, pelo protocolo partilhartela://auth/callback.
// A troca do code pela sessão é feita pelo renderer no servidor, que tem o client secret.

const loopbackPort = 53134;
const loopbackRedirect = `http://127.0.0.1:${loopbackPort}/callback`;
const protocolRedirect = 'partilhartela://auth/callback';
const timeoutMs = 5 * 60 * 1000;

export type AuthorizeResult = { code: string; codeVerifier: string; redirectUri: string };

type Pending = {
  state: string;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

let pending: Pending | undefined;

function settle(action: (p: Pending) => void): void {
  const current = pending;
  if (!current) return;
  pending = undefined;
  current.cleanup();
  action(current);
}

/** Resposta do Discord (loopback ou protocolo). Ignora o que não bate com o `state` pendente. */
function handleCallback(params: URLSearchParams): boolean {
  if (!pending || params.get('state') !== pending.state) return false;
  const error = params.get('error');
  const code = params.get('code');
  if (error) {
    settle((p) => p.reject(new Error(error === 'access_denied' ? 'Login com Discord cancelado.' : `O Discord recusou o login (${error}).`)));
  } else if (code && /^[A-Za-z0-9_-]{10,200}$/.test(code)) {
    settle((p) => p.resolve(code));
  } else {
    settle((p) => p.reject(new Error('O Discord não devolveu um código de login válido.')));
  }
  return true;
}

export function handleProtocolAuth(url: URL): void {
  handleCallback(url.searchParams);
}

const donePage = (ok: boolean) => `<!doctype html><meta charset="utf-8"><title>PartilharTela</title>
<body style="font-family:system-ui;background:#1b1c20;color:#ececf1;display:grid;place-items:center;min-height:100vh;margin:0">
<p>${ok ? 'Login concluído. Pode voltar ao PartilharTela.' : 'Login não concluído. Volte ao PartilharTela e tente de novo.'}</p></body>`;

function startLoopback(): Promise<http.Server | undefined> {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', loopbackRedirect);
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const ok = handleCallback(url.searchParams) && url.searchParams.has('code');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(donePage(ok));
    });
    server.once('error', () => resolve(undefined));
    server.listen(loopbackPort, '127.0.0.1', () => resolve(server));
  });
}

export async function authorizeWithDiscord(clientId: unknown): Promise<AuthorizeResult> {
  if (typeof clientId !== 'string' || !/^\d{15,22}$/.test(clientId)) {
    throw new Error('O servidor não informou um Client ID do Discord válido.');
  }
  settle((p) => p.reject(new Error('Login substituído por uma nova tentativa.')));

  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');
  const server = await startLoopback();
  const redirectUri = server ? loopbackRedirect : protocolRedirect;

  const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'identify',
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'none'
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => settle((p) => p.reject(new Error('O login com Discord não foi concluído a tempo.'))), timeoutMs);
    pending = {
      state,
      resolve,
      reject,
      cleanup: () => {
        clearTimeout(timer);
        server?.close();
      }
    };
    shell.openExternal(authorizeUrl.toString()).catch(() => {
      settle((p) => p.reject(new Error('Não foi possível abrir o navegador para o login.')));
    });
  });
  return { code, codeVerifier, redirectUri };
}

// ---------- Sessão salva com safeStorage (DPAPI no Windows) ----------

const sessionFile = () => path.join(app.getPath('userData'), 'discord-session.bin');

export async function saveSession(value: unknown): Promise<void> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw new Error('Sessão inválida.');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Este computador não permite guardar a sessão com segurança; você vai precisar entrar de novo ao reabrir o app.');
  }
  await fs.writeFile(sessionFile(), safeStorage.encryptString(value));
}

export async function loadSession(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(await fs.readFile(sessionFile()));
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await fs.rm(sessionFile(), { force: true });
}
