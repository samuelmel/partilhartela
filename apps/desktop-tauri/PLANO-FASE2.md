> **Passo 0 (feito).** `cargo check` passou depois de: (1) `target-dir = "C:/pt-target"` em `.cargo/config.toml`, porque os
> headers do libwebrtc passam de 260 caracteres de caminho dentro do repositório (cl.exe dava C1083); (2) feature
> `rustls-tls-native-roots` no `livekit` (wss em produção); (3) ajustes de imports do `windows` 0.62 (`DXGI_ERROR_*` em
> `Win32::Graphics::Dxgi`). Se o download do libwebrtc der 504, aponte `LK_CUSTOM_WEBRTC` para uma cópia local extraída.
> Para depurar a webview: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.

# Plano: Fase 2 do app Tauri (transmitir a tela pelo Rust)

Este plano é para quem vai implementar. Leia o `CLAUDE.md` da raiz antes de começar: ele tem as convenções (textos em pt-BR, commits `tipo(escopo): mensagem` sem linha Co-Authored-By, verificação obrigatória).

## Onde estamos

**Pronto e commitado (ec891f3, Fase 1).** `apps/desktop-tauri` é Tauri 2 + Vite + React. Ele entra numa sala existente pelo código e assiste às transmissões com `livekit-client` na webview. Reaproveita `Stage`, `RoomSidebar`, `roomState`, modo RPG (só como espectador) e os avisos sonoros de `shared/ui`.

**Começado e sem commit (Fase 2):**

| Arquivo | O que tem | Estado |
|---|---|---|
| `src-tauri/Cargo.toml` | dependências `livekit 0.10.1`, `libwebrtc 0.4.0`, `wasapi 0.26`, `windows 0.62`, `tokio`, `reqwest`, `serde` | adicionadas, nunca usadas |
| `.cargo/config.toml` | `+crt-static` (o webrtc-sys exige CRT estático no MSVC) | ok |
| `src-tauri/src/media/capture.rs` | captura da tela via DXGI Desktop Duplication, só o monitor 0, BGRA para NV12 com redução para no máximo 1920x1080 | escrito, não compilado |
| `src-tauri/src/media/encoder.rs` | encoder H.264 do Windows (Media Foundation), saída Annex-B | escrito, não compilado, com riscos (ver abaixo) |
| `src-tauri/src/media/audio.rs` | áudio do sistema via WASAPI loopback, PCM16 estéreo 48 kHz em blocos de 10 ms | escrito, não compilado |
| `apps/server/src/index.ts` | `POST /rooms/:code/token` aceita `share: true` + `shareOf`; devolve `identity`; o token de transmissão usa a identity `<base>-share` e grava `shareOf` na metadata | escrito, não testado |

**Ainda não existe:** `mod media` em `lib.rs`, nenhum comando Tauri, nenhuma conexão LiveKit no Rust, nenhuma tela para transmitir, nenhum jeito de criar sala.

## O que falta em relação ao app Electron

| Recurso | Electron | Tauri hoje |
|---|---|---|
| Entrar por código e assistir | sim | sim |
| Criar sala (e virar o criador do modo RPG) | sim | não |
| Transmitir a tela | sim | não |
| Escolher monitor ou janela (com miniatura) | sim | não |
| Áudio: nenhum / sistema / um aplicativo / sistema sem o Discord | sim | só o código do "sistema", desligado |
| Mutar o som da transmissão sem parar | sim | não |
| Qualidade (720p/1080p, 30/60 fps) e codificador | sim | não |
| Transmissão obedecer ao modo RPG (pausar o vídeo) | sim | não |
| Estatísticas (FPS, bitrate, gargalo) | sim | não |
| Login com Discord e link `partilhartela://join/CODIGO` | sim | não |
| Atualização automática | sim (electron-updater) | não |
| CSP na webview | sim | `csp: null` |

## Decisões de arquitetura (já tomadas, não mudar sem motivo)

1. **Dois participantes por pessoa.** A webview continua sendo o espectador (`livekit-client`). Quem transmite é o Rust, conectado como um segundo participante com a identity `<identity da webview>-share` e `{"shareOf": "<identity da webview>"}` na metadata. É isso que a mudança do server prepara.
2. **A webview pede o token de transmissão** (`POST /rooms/:code/token` com `{ share: true, shareOf: <sua identity> }`, mandando o `Authorization: Bearer` quando houver login) e entrega `{ url, token }` ao Rust. O Rust não fala com o servidor de salas.
3. **Vídeo pré-codificado.** O `libwebrtc 0.4.0` tem `NativeVideoSource::new_encoded(resolution)` + `capture_encoded_frame(&EncodedVideoFrame { codec: H264, payload, timestamp_us, frame_type, resolution, frame_metadata: None })`, e expõe `take_keyframe_request()` e `take_rate_control_request()` (bitrate e fps alvo pedidos pelo WebRTC). O `encoder.rs` existe para isso.
4. **Caminho de reserva:** `NativeVideoSource::new(resolution, true)` + `capture_frame` com frames crus (NV12/I420), deixando o próprio libwebrtc codificar. Use-o para a primeira versão funcionar de ponta a ponta antes de ligar o encoder do Media Foundation (passo 4).

## Passos

Cada passo termina com o app compilando e com o que ele pede verificado. Faça um commit por passo.

### Passo 0: compilar as dependências (causa já diagnosticada)

Na pasta de build padrão (`src-tauri/target`), o `cargo check` **falha** no webrtc-sys com `fatal error C1083` (não acha `absl/strings/internal/stringify_sink.h`). O arquivo existe. O caminho completo tem 262 caracteres, e o `cl.exe` não abre caminhos com mais de 260. A pasta do projeto já é longa.

Com uma pasta de build curta o `cargo check` passa: foi testado em 05/11/2026 com `CARGO_TARGET_DIR=D:/pt-target`, compilando as dependências novas em 7m33s.

- Em `apps/desktop-tauri/.cargo/config.toml`, acrescentar dentro de `[build]` a linha `target-dir = "D:/pt-target"` (ou outra pasta curta fora do projeto). Assim, `cargo`, `tauri dev` e `tauri build` usam a mesma pasta.
- Conferir que `npm run dev:tauri` e `npm run build:tauri` acham o executável nessa pasta. O Tauri CLI respeita o `target-dir` do Cargo.
- Ainda não declarar `mod media`: os três arquivos de `media/` nunca foram compilados e vão dar erros. Eles entram no passo 3.

**Commit:** `chore(tauri): pasta de build curta e dependências da Fase 2`. Inclui o `Cargo.toml` e o `Cargo.lock` atualizados.

### Passo 1: server, token de transmissão

Em `apps/server/src/index.ts`:
- Revisar a mudança que já está lá.
- No token com `share`, usar `canSubscribe: false`: o Rust não precisa receber nada, e isso evita banda e eco.
- Manter `canPublishSources` com `SCREEN_SHARE` e `SCREEN_SHARE_AUDIO`.

Sem login, `shareOf` é só o que o cliente diz: serve para agrupar na interface, não para autorizar nada. Deixe um comentário dizendo isso.

**Verificar:** `npm run typecheck`. Com `curl`, conferir que o token com `share` traz `identity` terminando em `-share` e que a metadata tem `shareOf`.

**Commit:** `feat(server): token de transmissão para o app nativo`.

### Passo 2: `shared/ui` entende o participante `-share`

Em `shared/ui/roomState.ts` (`readRoomSnapshot`):
- Um participante remoto com `shareOf` na metadata é a transmissão de outra pessoa:
  - não aparece como pessoa na lista;
  - marca o dono como `sharing`;
  - usa o nome do dono no stream e no áudio;
  - a chave de `audio` e `streams` é a identity do dono, para o volume e o rótulo saírem certos.
- Se `shareOf` for a identity local (é a minha própria transmissão vinda do Rust):
  - **nunca assinar o áudio** (`setSubscribed(false)` na publicação ScreenShareAudio), senão a pessoa escuta o próprio som com atraso;
  - mostrar o vídeo como "Sua tela" (`local: true` no `Stage`, sem controle de volume).

Em `shared/ui/shareSounds.ts`, tratar a identity `-share` como o dono, para não tocar dois avisos.

Electron e web não usam `shareOf`, então o comportamento deles não pode mudar.

**Verificar:**
- `npm run typecheck && npm run typecheck:web && npm run typecheck:tauri`.
- `npm run test:e2e:web` deve continuar 51/51. Precisa de LiveKit local, `dev:server` e `dev:web` com `VITE_TOKEN_SERVER_URL=http://localhost:8787`.

**Commit:** `feat(room): agrupa a transmissão do app nativo com o dono`.

### Passo 3: Rust publica a tela inteira (caminho cru)

Novo `src-tauri/src/share.rs`, com o estado num `tauri::State<Mutex<Option<ShareSession>>>`.

Comandos Tauri:
- `start_share({ url, token, quality: { width, height, fps, bitrate }, audio: "none" | "system" })`
- `stop_share()`
- `set_share_audio_muted(muted: bool)`

Eventos para a webview: `share:state` com `{ state: "starting" | "live" | "stopped" | "error", message? }`.

Conexão:
- `livekit::Room::connect(url, token, RoomOptions { auto_subscribe: false, .. })`.
- Publicar o vídeo com `LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source))` e `TrackPublishOptions { source: TrackSource::Screenshare, video_codec: VideoCodec::H264, simulcast: false, video_encoding: Some(VideoEncoding { max_bitrate, max_framerate }) }`.
- Publicar o áudio com `NativeAudioSource` (48000, 2 canais) e `TrackSource::ScreenshareAudio`. Usar o `audio.rs` atual; `muted` já existe nele.

Threads:
- Captura: uma `std::thread` em loop. Usa `capture.rs`, converte para o buffer cru e chama `capture_frame`. Limitar ao fps escolhido.
- Áudio: uma `std::thread` com `run_loopback`. Ela envia por canal tokio para uma task que chama `capture_frame` com `AudioFrame` de 480 amostras por canal.
- Parar: `AtomicBool`, `unpublish` dos dois tracks, `room.close()`. Parar também no fechamento da janela (`RunEvent::ExitRequested`).

Modo RPG:
- Ler `room.metadata()` ao conectar e ouvir `RoomEvent::RoomMetadataChanged`.
- Com `{"rpg":{"version":N}}`, parar de enviar frames de vídeo (ou dar `mute` na publicação). Ao desligar, voltar a enviar e pedir um keyframe.
- É a mesma regra de `shared/ui/rpgMode.ts`.

Na webview:
- Botão "Compartilhar tela" num dock simples, com qualidade e áudio.
- O dock pede o token de transmissão (passo 1), chama `start_share` e mostra o estado pelo evento.
- Botões "Mutar som" e "Parar transmissão".
- Erros do Rust (`String` em pt-BR) aparecem como aviso, como no Electron.

**Verificar:**
1. `cargo clippy` sem erros e `npm run typecheck:tauri`.
2. Subir o LiveKit local (`docker compose -f infra/docker-compose.yml up -d`), `npm run dev:server` e `npm run dev:tauri`.
3. Entrar pela web (`npm run dev:web`) em outra máquina ou aba e confirmar:
   - vídeo aparece;
   - o som do sistema toca;
   - o mute funciona;
   - parar some a transmissão para todos;
   - o próprio app Tauri não reproduz o som da sua transmissão.
4. Ligar o modo RPG por um criador web: os espectadores ficam sem vídeo e com áudio.

**Commit:** `feat(tauri): transmite a tela pelo Rust`.

### Passo 4: encoder H.264 do Windows (pré-codificado)

Trocar o caminho cru por `NativeVideoSource::new_encoded` + `capture_encoded_frame` com o `encoder.rs`. Antes de ligar, corrigir os riscos do `encoder.rs`:

- **MFT de hardware é assíncrono.** Com `MF_TRANSFORM_ASYNC_UNLOCK`, chamar `ProcessInput`/`ProcessOutput` em sequência, como o código faz, não funciona: dá `MF_E_NOTACCEPTING` ou fica sem saída. Ou implementar o modelo de eventos (`IMFMediaEventGenerator`: `METransformNeedInput` / `METransformHaveOutput`), ou começar só com o MFT de software síncrono e deixar o hardware para depois. Decidir medindo.
- **SPS/PPS em todo keyframe.** Alguns MFTs só mandam SPS/PPS no `MF_MT_MPEG_SEQUENCE_HEADER` do tipo de saída. Se o keyframe vier sem NAL 7/8, colar o sequence header antes dele. Sem isso, quem entra depois não consegue decodificar.
- **Pedidos do WebRTC.** Atender `take_keyframe_request()` com `force_keyframe` (ou `restart()` quando `can_force_keyframe()` for falso). Atender `take_rate_control_request()` mudando o bitrate (`CODECAPI_AVEncCommonMeanBitRate`).
- **`MFStartup`/`CoInitializeEx` por thread.** O `Drop` chama `MFShutdown`/`CoUninitialize`. Criar e destruir o encoder sempre na thread de captura.
- Manter o caminho cru como reserva automática se nenhum encoder H.264 funcionar.

**Verificar:** mesmo roteiro do passo 3, mais:
- CPU do app transmitindo 1080p30 por 2 minutos, comparando com o passo 3 (anotar os números no commit);
- quem entra no meio da transmissão vê a imagem em até 2 s.

**Commit:** `feat(tauri): codifica a tela com o H.264 do Windows`.

### Passo 5: escolher monitor ou janela

- O `capture.rs` só pega o monitor 0. Trocar por `libwebrtc::desktop_capturer::DesktopCapturer`: tem `DesktopCaptureSourceType::Screen` e `Window`, `get_source_list()` e frames BGRA. Ou estender o DXGI para todos os monitores e usar Windows.Graphics.Capture para janelas. Recomendo o `DesktopCapturer` (menos código nosso).
- Comando `list_sources()` devolve `[{ id, kind: "screen" | "window", title }]`. Miniaturas: capturar um frame por fonte, reduzir para 320 px e mandar PNG em base64. Se ficar lento, entregar a lista sem miniatura primeiro.
- Modal de escolha na webview, igual ao `ShareModal` do Electron (`apps/desktop/src/renderer/main.tsx`).
- Atenção: em notebook com duas GPUs, o DXGI falha (`DXGI_ERROR_UNSUPPORTED`) quando o monitor está ligado na outra placa. É mais um motivo para usar o `DesktopCapturer`.

**Commit:** `feat(tauri): escolha de monitor ou janela`.

### Passo 6: áudio por aplicativo e "sistema sem o Discord"

- `wasapi::AudioClient::new_application_loopback_client(pid, include_tree)`:
  - `include_tree: true` = só aquele aplicativo;
  - `false` = tudo menos ele, que é o modo "sistema sem o Discord".
- Isso precisa de Windows 10 2004 ou mais novo; mostre um erro claro se não houver.
- Comando `list_audio_processes()` (ToolHelp32 já está nas features do `windows`) com nome e PID, só processos com janela.
- Ao escolher uma janela no passo 5, sugerir o PID dela para o modo "aplicativo".

**Commit:** `feat(tauri): áudio por aplicativo`.

### Passo 7: criar sala e controle do modo RPG

- Home: botão "Criar sala" (`POST /rooms`), guardando o `hostKey` na sessão.
- Na sala, `RpgControl` na barra lateral quando houver `hostKey`, como na web.
- Trocar `csp: null` por uma CSP equivalente à do Electron (`apps/desktop/vite.config.ts`), liberando `ipc:` e `http://ipc.localhost` para os comandos do Tauri.

**Commit:** `feat(tauri): criar sala e modo RPG`.

## Fica para depois (planos separados)

- Login com Discord (`tauri-plugin-deep-link` + `tauri-plugin-opener`, PKCE igual a `apps/desktop/src/main/discordAuth.ts`) e o link `partilhartela://join/CODIGO`.
- Atualização automática com `tauri-plugin-updater`. Ela usa outro formato (`latest.json` assinado) e não pode quebrar o `latest.yml` que o app Electron lê nas mesmas Releases.
- Estatísticas (o `livekit` do Rust expõe `get_stats()` nas publicações).
- Codificadores além do H.264.

## Riscos para acompanhar

- O libwebrtc do LiveKit para Windows pode não trazer encoder H.264 no caminho cru (passo 3). Se o vídeo não sair, use `VideoCodec::VP8` só para validar o resto e siga para o passo 4.
- Eco: o app Tauri nunca pode tocar o áudio da própria transmissão (passo 2).
- Mesmo usuário em dois aparelhos com Discord: identity igual derruba a conexão mais antiga. A identity `-share` não muda isso.
