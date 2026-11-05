# PartilharTela

Compartilhamento de **tela e áudio ao vivo** com baixa latência. Qualquer pessoa da sala transmite e assiste, pelo
app para Windows ou pelo navegador. A mídia trafega por WebRTC ([LiveKit](https://livekit.io)); um servidor
Fastify cria as salas, assina os tokens e faz o login com Discord; um bot liga cada canal de voz do Discord a uma
sala.

O app para Windows é feito em **Tauri 2 + Rust**: o Rust captura a tela (telas e janelas), codifica em H.264 pelo
Windows (Media Foundation), captura o áudio por aplicativo (WASAPI) e publica tudo no LiveKit. A interface é React.

---

## Para quem usa

### Instalar

Baixe o instalador `PartilharTela_x.y.z_x64-setup.exe` na página de
[Releases](https://github.com/samuelmel/partilhartela/releases/latest) e execute. O app se atualiza sozinho: ao
abrir, ele procura uma versão nova e mostra o botão **Atualizar agora**.

### Transmitir

1. Abra o app e clique em **Criar sala** (ou **Entrar com Discord** e depois **Entrar na call atual**).
2. Copie o código de 6 caracteres (ou o link do convite) e mande para os outros.
3. Clique em **Compartilhar tela**, escolha uma **tela** ou uma **janela** e o som:
   - *Sem som*, *Som do sistema*, *Som de um aplicativo* (só o som daquela janela) ou *Sistema, menos um aplicativo*.
4. Escolha a qualidade (720p30, 1080p30 ou 1080p60) e o modo:
   - **Movimento e jogos**: mantém todos os quadros por segundo. Bom para jogos, vídeos e cutscenes.
   - **Texto e código**: no máximo 15 quadros por segundo, com cada quadro mais nítido. Bom para ler.
   - Os dois podem ser trocados durante a transmissão.

### Assistir

- **No app**: informe o código da sala.
- **No navegador**: abra o link da sala (`?room=CODIGO`). Funciona em Chrome, Edge, Firefox e no celular. No
  navegador o som da transmissão só sai em Chrome e Edge; celular e tablet só assistem.

### Modo RPG

Quem criou a sala escolhe uma imagem e liga o modo na barra lateral: quem assiste passa a ver só a imagem e a ouvir
o áudio da transmissão. Serve para esconder a tela e tocar só o som (por exemplo, durante uma cutscene).

---

## Para quem desenvolve

### Pré-requisitos

- Windows 10/11
- Node.js 22.13+ e npm 10+ (o servidor usa `node:sqlite`)
- Rust estável com o alvo MSVC e o WebView2 (para o app Tauri)
- Docker, só para rodar o LiveKit local

### Comandos (na raiz)

```bash
npm install                 # instala todos os workspaces
npm run dev:server          # servidor de salas em :8787
npm run dev:tauri           # app Tauri em modo de desenvolvimento
npm run dev:web             # viewer web em :5174
npm run dev:bot             # bot do Discord (precisa de apps/bot/.env)
npm run typecheck           # server, bot e Tauri
npm run typecheck:web
npm run build:web
npm run build:tauri         # build + instalador NSIS
npm run test:e2e:web        # E2E do viewer web (precisa do LiveKit local, dev:server e dev:web)
docker compose -f infra/docker-compose.yml up -d   # LiveKit local em ws://localhost:7880
```

Variáveis de ambiente: um `.env` por app, ignorado pelo git. O `.env.example` da raiz lista todos os nomes.
O app Tauri lê `VITE_TOKEN_SERVER_URL` (endereço do servidor de salas) no momento do build.

### Publicar uma versão

1. Suba a versão em `apps/desktop-tauri/package.json`, `src-tauri/Cargo.toml` e `src-tauri/tauri.conf.json`.
2. `npm run build:tauri` e assine o instalador com a chave do updater
   (`tauri signer sign --private-key-path <chave> <instalador>`).
3. `node scripts/release-tauri.mjs` cria o release `vX.Y.Z` no GitHub com o instalador, o `.sig`, o `latest.json`
   (lido pelo updater do Tauri) e o `latest.yml`. Use `--dry` para só conferir os arquivos.

O updater lê `releases/latest/download/latest.json`: o release mais recente precisa sempre ter esse arquivo.
A chave privada do updater não vai para o repositório; sem ela não dá para publicar atualizações assinadas.

### Estrutura

```text
apps/
  desktop-tauri/     # app Windows: React (src/) + Rust (src-tauri/)
    src-tauri/src/   #   share.rs (publicação), media/ (captura, encoder, áudio), sources.rs, auth.rs
  server/            # Fastify: salas e tokens LiveKit, SQLite, login Discord, /join e API do bot
  bot/               # bot do Discord (discord.js): sala por canal de voz e comando /tela
  web/               # viewer e transmissor web
shared/ui/           # componentes e estilos usados pelo app Tauri e pelo web
scripts/             # e2e do web e publicação de releases
infra/               # docker-compose e configuração do LiveKit local
```

### Produção

- Servidor de salas: Render (web service `partilhartela`). Site web: Render (static site, pasta `apps/web`).
  Como o static site só reconstrói quando algo muda dentro de `apps/web`, mudanças em `shared/ui` pedem um
  deploy manual dele.
- Mídia: LiveKit.
- No plano gratuito do Render o disco é efêmero: o SQLite (salas e sessões) é apagado a cada deploy ou hibernação.

---

## Integração com o Discord

O Discord não é modificado: um **bot** (`apps/bot`) observa os canais de voz e o **servidor** (`apps/server`)
liga cada canal a uma sala.

- A primeira pessoa entrou num canal de voz: o servidor cria a sala do canal e o bot manda no chat do canal um botão
  **"Assistir / Compartilhar tela"** para `PUBLIC_BASE_URL/join/<CODIGO>`.
- `/join/<CODIGO>` tenta abrir `partilhartela://join/<CODIGO>` (o app entra direto na sala) e mostra o link de
  download se o app não estiver instalado.
- `/tela` cria (ou reaproveita) a sala do canal em que você está e responde com o mesmo botão.
- Canal esvaziou: a sala é encerrada e a mensagem vira "Sala encerrada".
- No app: **Entrar com Discord** (OAuth2 + PKCE, escopo `identify`) e depois **Entrar na call atual**. Com login, o
  participante aparece com o nome e o avatar do Discord. O código de 6 caracteres continua funcionando.

### 1. Criar o app no Discord Developer Portal

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2**: copie o **Client ID** e gere o **Client Secret** → `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET`
   no `apps/server/.env` (ou nas variáveis do serviço no Render).
3. **OAuth2 → Redirects**: cadastre exatamente estas duas:
   - `http://127.0.0.1:53134/callback`
   - `partilhartela://auth/callback`
4. **Bot**: **Reset Token** e copie → `DISCORD_BOT_TOKEN` no `apps/bot/.env`.
5. **Intents**: o bot usa só `Guilds` e `GuildVoiceStates`, que não são privilegiadas.

### 2. Convidar o bot

Troque `CLIENT_ID` pelo seu Client ID:

```text
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=3072
```

`3072` = Ver canais + Enviar mensagens. O escopo `applications.commands` registra o `/tela`.

### 3. Configurar e rodar

```bash
# apps/server/.env: LIVEKIT_*, PUBLIC_BASE_URL, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, BOT_API_SECRET
# apps/bot/.env:    DISCORD_BOT_TOKEN, BACKEND_URL, BOT_API_SECRET (mesmo valor do server), DISCORD_DEV_GUILD_ID (opcional)
docker compose -f infra/docker-compose.yml up -d
npm run dev:server
npm run dev:bot
npm run dev:tauri
```

Gere o `BOT_API_SECRET` com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Em produção
o bot é um processo contínuo: um web service gratuito do Render hiberna e o bot cairia junto.

O Discord só aceita botões com URL pública. Com `PUBLIC_BASE_URL=http://localhost:8787` o bot manda o link no texto
em vez do botão; para testar o botão, exponha o servidor com um túnel (`cloudflared tunnel --url http://localhost:8787`).
O protocolo `partilhartela://` é registrado pelo instalador.

---

## Recursos

- Transmissão de tela inteira ou de uma janela, com codificação H.264 pelo Windows.
- Som do sistema, de um aplicativo ou do sistema menos um aplicativo (Windows).
- Qualidade (720p30, 1080p30, 1080p60) e modo (movimento ou texto) trocáveis durante a transmissão.
- Salas por código de 6 caracteres, link de convite e viewer web sem instalação.
- Modo RPG: esconde a tela e mostra uma imagem, mantendo o áudio.
- Integração com o Discord: sala por canal de voz, botão no chat, `/tela`, login e avatares.
- Atualização automática do app.
