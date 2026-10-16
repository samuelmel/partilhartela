# PartilharTela

Compartilhamento de tela + áudio ao vivo. O apresentador usa o app desktop (Electron/Windows),
espectadores entram pelo desktop ou pelo navegador (`apps/web`). A mídia trafega via LiveKit
(WebRTC); o servidor Fastify só cria códigos de sala e assina tokens JWT do LiveKit.

## Stack (versões instaladas)

| Peça | Versão |
|---|---|
| Node / npm | 20+ / 10+ (testado com 24 / 11) |
| Electron | 44.7.0 (fixo) · electron-builder 26 · electron-updater 6 |
| React | 18.3 · Vite 6 · TypeScript 5.9 (strict em todos os apps) |
| livekit-client | 2.22 (desktop e web) · livekit-server-sdk 2.19 (server) |
| Fastify | 5 + @fastify/cors, @fastify/rate-limit · nanoid 5 |
| loopback-capture | 3.0 (módulo nativo, captura de áudio por PID no Windows) |

## Estrutura

```text
apps/
  desktop/                 # @partilhartela/desktop — versão que o auto-update usa
    src/main/main.ts       # processo principal: janela, permissões, desktopCapturer, IPC, áudio loopback, autoUpdater
    src/preload/preload.ts # contextBridge -> window.partilharTela (único canal renderer<->main)
    src/renderer/main.tsx  # UI React inteira (home, join, sala) + LiveKit; tipos da bridge em vite-env.d.ts
    tsconfig.main.json     # main+preload -> out/ (CommonJS)
    tsconfig.renderer.json # renderer, só typecheck; build pelo Vite -> apps/desktop/dist
    .env.production        # VITE_TOKEN_SERVER_URL usado no build empacotado
  server/src/index.ts      # Fastify: /health, POST /rooms, POST /rooms/:code/token (ESM, NodeNext)
  web/src/main.tsx         # viewer somente-assistir para navegador (?room=CODIGO)
infra/                     # docker-compose + livekit.yaml para LiveKit local (chaves dev: devkey/secret)
```

Workspaces npm na raiz; um único `package-lock.json`.

## Comandos (rodar na raiz)

```bash
npm install                 # instala todos os workspaces (loopback-capture compila nativo)
npm run dev                 # = dev:desktop: server (tsx watch :8787) + Vite :5173 + Electron
npm run dev:server          # só o servidor de tokens
npm run dev:web             # viewer web em :5174 (--host 0.0.0.0)
npm run typecheck           # server + desktop (main/preload e renderer)
npm run typecheck:web
npm run build               # server (tsc -> apps/server/dist) + desktop (tsc + vite)
npm run build:web
npm run dist                # build + instalador NSIS em apps/desktop/release/
docker compose -f infra/docker-compose.yml up -d   # LiveKit local em ws://localhost:7880
```

Não há lint nem testes automatizados. Verificação = `npm run typecheck && npm run typecheck:web && npm run build && npm run build:web`.

## Variáveis de ambiente

Um `.env` por app (ignorados pelo git): `apps/server/.env` (lido por `dotenv/config` no cwd do
workspace), `apps/desktop/.env` (Vite com `envDir: '../..'` relativo a `src/renderer` = `apps/desktop`)
e `apps/web/.env`. O `.env.example` da raiz lista todos os nomes.

| Nome | Usado por | Observação |
|---|---|---|
| `LIVEKIT_URL` | server | devolvido ao cliente; padrão `ws://localhost:7880` |
| `LIVEKIT_API_KEY` | server | obrigatória com `NODE_ENV=production` |
| `LIVEKIT_API_SECRET` | server | obrigatória com `NODE_ENV=production`; nunca vai para o cliente |
| `SERVER_PORT` / `PORT` | server | `PORT` (Render) tem prioridade; padrão 8787 |
| `VITE_TOKEN_SERVER_URL` | desktop, web | embutida no bundle no build; padrão `http://localhost:8787` |

## Fluxo principal

1. **Criar sala** (desktop): `POST /rooms {nickname}` → server gera código de 6 chars
   (alfabeto sem 0/O/1/I), guarda em memória e devolve token (TTL 15 min) para a sala
   `partilhartela-<CODIGO>`. Renderer conecta com `new Room(...).connect(livekitUrl, token)`.
2. **Entrar**: `POST /rooms/:code/token` → 404 se o código não estiver no Map em memória
   (reiniciar o server invalida todas as salas). Viewers também recebem `canPublish`.
3. **Captura de vídeo**: renderer pede `getSources()` (IPC `desktop:get-sources`), usuário
   escolhe, `setCaptureSource(id)` grava o id no main, e `getDisplayMedia()` é atendido por
   `setDisplayMediaRequestHandler`, que devolve a fonte escolhida (+ `audio: 'loopback'`).
4. **Áudio**: `none` | `system` (loopback do getDisplayMedia) | `application` (PID da janela) |
   `system-excluding-discord` (sistema menos um PID). Os dois últimos usam `loopback-capture`
   no main, que envia PCM16 estéreo 48 kHz por `audio:data`; o renderer monta um
   `AudioContext` → `MediaStreamDestination` → `LocalAudioTrack` (`createPcmAudio`).
5. **Publicação**: `publishTrack` com `Track.Source.ScreenShare` (H.264, sem simulcast,
   bitrate/fps do preset `qualities`) e `ScreenShareAudio`. Trocar qualidade republica.
6. **Visualização**: `TrackSubscribed` alimenta `videoStreams`/`audioTracks`; tiles fazem
   `track.attach(el)`; volume/mute por participante ficam em `audioSettings`.
7. **Atualização**: app empacotado chama `autoUpdater.checkForUpdatesAndNotify()` contra o
   GitHub Releases de `samuelmel/partilhartela` (config `build.publish` no package do desktop).

## Convenções

- Commits: `tipo(escopo): mensagem` em português; tipos feat, fix, refactor, style, chore, docs.
  Escopos usados: `desktop`, `server`, `web`, `release`.
- Textos de UI, erros e comentários em português (pt-BR). Logs do renderer/main com prefixo `[PartilharTela]`.
- Toda API nova do main passa por `ipcMain.handle` + entrada em `preload.ts` + tipo em
  `renderer/vite-env.d.ts`. Valide argumentos no main (`typeof`, `Number.isInteger`) e lance `Error` com mensagem para o usuário.
- `BrowserWindow` sempre com `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Componentes React em arquivo único por app; estado em `useState`, valores lidos em callbacks assíncronos via `useRef`.

## Limitações conhecidas

- Salas vivem só na memória do server (sem persistência; Render free hiberna e perde os códigos).
- Áudio por aplicativo/exclusão só no Windows; o PID da janela é inferido comparando títulos
  (`Get-Process` via PowerShell), pode falhar com títulos iguais ou dinâmicos.
- Só gera instalador Windows (NSIS); `dist` não assina o executável.
- Bundles do renderer/web ~720 kB (aviso do Vite) — livekit-client não é dividido.
- `npm audit` acusa 8 moderadas em dependências de build do electron-builder (não empacotadas).
- O desktop não tem botão "Sair da sala"; fechar o app encerra a conexão.
