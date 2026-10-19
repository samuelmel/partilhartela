# PartilharTela

Compartilhamento de tela + áudio ao vivo. Qualquer participante transmite e assiste, pelo app
desktop (Electron/Windows) ou pelo navegador (`apps/web`); o desktop acrescenta áudio por aplicativo. A mídia trafega via LiveKit
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
    src/renderer/main.tsx  # início, seletor de fonte, dock, captura/publicação; tipos da bridge em vite-env.d.ts
    tsconfig.main.json     # main+preload -> out/ (CommonJS)
    tsconfig.renderer.json # renderer, só typecheck; build pelo Vite -> apps/desktop/dist
    .env.production        # VITE_TOKEN_SERVER_URL usado no build empacotado
  server/src/index.ts      # Fastify: /health, POST /rooms, POST /rooms/:code/token, PUT/DELETE /rooms/:code/rpg,
                           # GET /rooms/:code/rpg/image (ESM, NodeNext)
  web/src/                 # main.tsx (App), Home.tsx, RoomScreen.tsx, ShareDock.tsx (getDisplayMedia),
                           # session.ts (rotas/conexão), capture.ts (suporte e erros de captura)
shared/ui/                 # usado por desktop e web: base.css/room.css (tokens e layout), Stage (palco,
                           # fullscreen, volume local), RoomSidebar, roomState (snapshot do SDK, mute), icons,
                           # rpgMode/RpgControl (modo RPG), shareSounds (avisos de início/fim)
scripts/e2e-web.mjs        # E2E da web via CDP (apresentador + espectadores + celular)
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
npm run test:e2e:web        # E2E web (precisa de dev:server + dev:web com VITE_TOKEN_SERVER_URL local)
docker compose -f infra/docker-compose.yml up -d   # LiveKit local em ws://localhost:7880
```

Não há lint nem testes unitários. Verificação = `npm run typecheck && npm run typecheck:web && npm run build && npm run build:web`;
mudanças em mídia/UI da sala: rode também `npm run test:e2e:web` (usa LiveKit real).

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
| `VITE_WEB_APP_URL` | desktop | opcional; com ela "Copiar" gera link `?room=` em vez do código |
| `VITE_DOWNLOAD_URL` | web | opcional; padrão `github.com/samuelmel/partilhartela/releases/latest` |

## Fluxo principal

1. **Criar sala** (desktop): `POST /rooms {nickname}` → server gera código de 6 chars
   (alfabeto sem 0/O/1/I), guarda em memória e devolve token (TTL 15 min) para a sala
   `partilhartela-<CODIGO>`. Desktop e web usam as mesmas rotas e conectam com `new Room(...).connect`.
   Tokens só permitem publicar `SCREEN_SHARE` e `SCREEN_SHARE_AUDIO` (`canPublishSources`).
2. **Entrar**: `POST /rooms/:code/token` → 404 se o código não estiver no Map em memória
   (reiniciar o server invalida todas as salas). Quem entra também pode transmitir.
3. **Captura de vídeo**: renderer pede `getSources()` (IPC `desktop:get-sources`), usuário
   escolhe, `setCaptureSource(id)` grava o id no main, e `getDisplayMedia()` é atendido por
   `setDisplayMediaRequestHandler`, que devolve a fonte escolhida (+ `audio: 'loopback'`).
4. **Áudio**: `none` | `system` (loopback do getDisplayMedia) | `application` (PID da janela) |
   `system-excluding-discord` (sistema menos um PID). Os dois últimos usam `loopback-capture`
   no main, que envia PCM16 estéreo 48 kHz por `audio:data`; o renderer monta um
   `AudioContext` → `MediaStreamDestination` → `LocalAudioTrack` (`createPcmAudio`).
5. **Publicação**: `publishTrack` com `Track.Source.ScreenShare` (H.264, sem simulcast,
   bitrate/fps do preset `qualities`) e `ScreenShareAudio`. Trocar qualidade republica.
5b. **Web**: `ShareDock` usa `localParticipant.setScreenShareEnabled` (áudio só em Chromium; a
   fonte pode não entregar som). Fim pelo botão nativo do navegador: o SDK despublica e o dock avisa.
6. **Visualização**: `useRoomSnapshot` relê tudo do SDK a cada evento (sem cópia própria de tracks).
   `Stage` tem um viewport fixo (alvo do fullscreen) + `<audio>` por faixa ScreenShareAudio com
   volume/mute locais (`localStorage` só guarda o volume padrão deste aparelho).
   Mute do apresentador = `publication.mute()` (`setShareAudioMuted`); não para a captura.
6b. **Modo RPG**: `POST /rooms` devolve `hostKey` só ao criador. Com ela, `PUT /rooms/:code/rpg`
   (corpo = imagem PNG/JPEG/WebP/GIF até 5 MB, header `X-Host-Key`) liga o modo e `DELETE` desliga; o
   server guarda a imagem em memória e grava `{"rpg":{"version":N}}` na metadata da sala via
   `RoomServiceClient`. `useRpgMode` lê a metadata, baixa a imagem como blob e aplica: espectadores
   desinscrevem o vídeo das telas (áudio continua) e quem transmite pausa o vídeo (`publication.mute()`),
   inclusive após republicar. `Stage` mostra a imagem no lugar do vídeo, com volume por áudio.
7. **Atualização**: app empacotado chama `autoUpdater.checkForUpdatesAndNotify()` contra o
   GitHub Releases de `samuelmel/partilhartela` (config `build.publish` no package do desktop).

## Convenções

- Commits: `tipo(escopo): mensagem` em português; tipos feat, fix, refactor, style, chore, docs.
  Escopos usados: `desktop`, `server`, `web`, `release`.
- Textos de UI, erros e comentários em português (pt-BR). Logs do renderer/main com prefixo `[PartilharTela]`.
- Toda API nova do main passa por `ipcMain.handle` + entrada em `preload.ts` + tipo em
  `renderer/vite-env.d.ts`. Valide argumentos no main (`typeof`, `Number.isInteger`) e lance `Error` com mensagem para o usuário.
- `BrowserWindow` sempre com `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Peças de sala comuns aos dois apps ficam em `shared/ui/` (import relativo; nada de pacote novo). Visual: tokens em `shared/ui/base.css`, sem cores soltas nos apps.
- Estado em `useState`, valores lidos em callbacks assíncronos via `useRef`; estado de mídia vem do SDK (`useRoomSnapshot`), não de flags próprias.

## Limitações conhecidas

- Salas vivem só na memória do server (sem persistência; Render free hiberna e perde os códigos).
- Áudio por aplicativo/exclusão só no Windows; o PID da janela é inferido comparando títulos
  (`Get-Process` via PowerShell), pode falhar com títulos iguais ou dinâmicos.
- Só gera instalador Windows (NSIS); `dist` não assina o executável.
- Bundles do renderer/web ~720 kB (aviso do Vite) — livekit-client não é dividido.
- `npm audit` acusa 8 moderadas em dependências de build do electron-builder (não empacotadas).
- Web: áudio só em Chrome/Edge (aba; tela inteira no Windows). Firefox/Safari transmitem sem som;
  celular/tablet só assistem. Sem isolamento por aplicativo no navegador.
- Electron não sai do fullscreen HTML com Esc sozinho: o `Stage` trata a tecla. A permissão
  `fullscreen` precisa continuar liberada em `setPermissionRequestHandler`.
- iOS ignora `HTMLMediaElement.volume`: lá o espectador só tem mute.
