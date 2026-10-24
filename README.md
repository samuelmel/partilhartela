# 🖥️ PartilharTela

Aplicativo desktop moderno e de baixa latência para **compartilhamento de tela e áudio ao vivo**, construído com **Electron**, **React**, **TypeScript** e **LiveKit (WebRTC)**.

Inclui captura de áudio exclusiva por aplicativo no Windows (para você compartilhar um jogo ou janela sem vazar o som do Discord ou outras chamadas) e suporte a espectadores via navegador web.

---

## 📦 Como Baixar e Usar (Usuário Final)

### 1. Download do Instalador Windows
- Baixe o instalador oficial mais recente: **`PartilharTela Setup 1.0.0.exe`** (disponível na aba [Releases](https://github.com/) ou no link compartilhado pelo desenvolvedor).
- Execute o arquivo `.exe` e conclua a instalação rápida no Windows.

### 2. Para Transmitir a Tela (Apresentador)
1. Abra o aplicativo **PartilharTela**.
2. Clique no botão **"Criar Sala"**.
3. Um código exclusivo de 6 caracteres será gerado (ex: `K9B2X4`).
4. Clique em **"Compartilhar Tela"**:
   - Escolha se deseja compartilhar a **Tela Inteira** ou uma **Janela de Aplicativo**.
   - Escolha o modo de **Áudio**:
     - *Áudio do aplicativo*: captura somente o som da janela escolhida (não vaza Discord nem chamadas).
     - *Áudio de todo o sistema*: captura todos os sons do computador.
     - *Sem áudio*.
   - Escolha a qualidade: `720p 30fps`, `1080p 30fps` ou `1080p 60fps`.
5. Envie o código da sala ou o link para seus amigos.

### 3. Para Assistir (Espectador)
- **Pelo App Desktop**: Abra o PartilharTela, clique em **"Entrar na Sala"**, informe o código e seu apelido.
- **Pelo Navegador Web**: Acesse o link da sala (ex: `https://seu-site.com/?room=K9B2X4`) para assistir direto pelo navegador (Chrome, Edge, Firefox, celular) sem precisar instalar nada!

---

## 🚀 Infraestrutura em Produção

O projeto já está integrado à nuvem:
- **Servidor de Salas & Tokens**: Hospedado no [Render](https://render.com) (`https://partilhartela-server.onrender.com`).
- **Servidor WebRTC / Mídia**: Hospedado no [LiveKit Cloud](https://cloud.livekit.io) para transmissão global de alta velocidade e baixa latência.

---

## 🛠️ Como Gerar o Instalador (.exe) para Distribuição

Para gerar uma nova versão executável do aplicativo desktop pronta para distribuição:

```bash
# 1. Instale as dependências (se ainda não instalou)
npm install

# 2. Gere o instalador para Windows (NSIS)
npm run dist
```

O arquivo instalável será gerado automaticamente em:
```text
apps/desktop/release/PartilharTela Setup 1.0.1.exe
```

### Onde hospedar para as pessoas baixarem:
1. **GitHub Releases (Recomendado)**: Crie uma nova Release na página do seu repositório no GitHub (`v1.0.0`) e faça o upload do arquivo `.exe`.

### Atualizações automáticas do desktop

O instalador NSIS verifica novas versões no GitHub Releases ao abrir o aplicativo. Quando uma versão nova estiver disponível, ela será baixada em segundo plano e o usuário poderá reiniciar o app para concluir a instalação.

Para publicar uma atualização:

1. Incremente a versão em `apps/desktop/package.json` (por exemplo, `1.0.1`).
2. Gere o instalador com `npm run dist`.
3. Crie uma GitHub Release com uma tag igual à versão, como `v1.0.1`.
4. Anexe o `.exe`, o arquivo `latest.yml` e o arquivo `.blockmap` gerados em `apps/desktop/release`.

2. **Google Drive / OneDrive / Dropbox**: Suba o `.exe` e compartilhe o link de download direto com seus usuários.
3. **Página Web**: Hospede o `apps/web` (na Vercel, Netlify ou Render) e adicione um botão "Baixar para Windows" apontando para o arquivo `.exe`.

Não basta trocar apenas o `.exe`: o `latest.yml` informa ao atualizador qual versão e quais arquivos devem ser baixados.

---

## 💻 Desenvolvimento Local

### Pré-requisitos
- **Windows 10/11**
- **Node.js 22.13+** e **npm 10+** (o servidor usa `node:sqlite`)

### Comandos de Desenvolvimento

```bash
# Iniciar o aplicativo desktop em modo de desenvolvimento
npm run dev:desktop

# Iniciar apenas o servidor backend localmente (porta 8787)
npm run dev:server

# Iniciar o cliente web de espectadores localmente (porta 5174)
npm run dev:web

# Checagem de tipos TypeScript em todo o monorepo
npm run typecheck
```

---

## 🎮 Integração com o Discord

O Discord não é modificado: um **bot** (`apps/bot`) observa os canais de voz e o **servidor**
(`apps/server`) liga cada canal a uma sala do PartilharTela.

- A primeira pessoa entrou num canal de voz → o servidor cria a sala do canal (no LiveKit:
  `partilhartela-dc-<guildId>-<channelId>`) e o bot manda no chat do canal de voz um botão
  **"Assistir / Compartilhar tela"** para `PUBLIC_BASE_URL/join/<CODIGO>`.
- `/join/<CODIGO>` tenta abrir `partilhartela://join/<CODIGO>` (o app entra direto na sala) e mostra o
  link de download se o app não estiver instalado.
- `/tela` cria (ou reaproveita) a sala do canal em que você está e responde com o mesmo botão.
- Canal esvaziou → a sala é encerrada (quem estava nela no LiveKit sai) e a mensagem vira "Sala encerrada".
- No app: **Entrar com Discord** (OAuth2 + PKCE, escopo `identify`) e depois **Entrar na call atual**.
  Com login, o participante aparece com o nome e o avatar do Discord. O código de 6 caracteres continua
  funcionando para quem não usa Discord.
- Salas, sessões de login e voice states ficam em SQLite no servidor (`node:sqlite`, Node 22.13+), então
  reiniciar o servidor não derruba as salas. A imagem do modo RPG continua só em memória.

### 1. Criar o app no Discord Developer Portal

1. Acesse <https://discord.com/developers/applications> → **New Application** (ex.: "PartilharTela").
2. **OAuth2**: copie o **Client ID** e gere o **Client Secret** → `DISCORD_CLIENT_ID` e
   `DISCORD_CLIENT_SECRET` no `apps/server/.env`.
3. **OAuth2 → Redirects**: cadastre exatamente as duas URIs (o app usa a primeira; a segunda é o
   plano B se a porta 53134 estiver ocupada):
   - `http://127.0.0.1:53134/callback`
   - `partilhartela://auth/callback`
4. **Bot**: clique em **Reset Token** e copie → `DISCORD_BOT_TOKEN` no `apps/bot/.env`.
   Desligue **Public Bot** se só você vai convidá-lo.
5. **Intents**: o bot usa só `Guilds` e `GuildVoiceStates`, que **não são privilegiadas** — não precisa
   ligar nenhuma chave em *Privileged Gateway Intents* (Presence, Server Members e Message Content ficam desligadas).

### 2. Convidar o bot (permissões mínimas)

Troque `CLIENT_ID` pelo seu Client ID:

```text
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=3072
```

`3072` = **Ver canais** (1024) + **Enviar mensagens** (2048). O escopo `applications.commands` registra o
`/tela`. Editar as próprias mensagens não exige permissão extra. Se o bot não puder escrever no chat de
algum canal de voz, a sala é criada mesmo assim e o `/tela` continua funcionando.

### 3. Configurar e rodar

```bash
# apps/server/.env: LIVEKIT_*, PUBLIC_BASE_URL, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, BOT_API_SECRET
# apps/bot/.env:    DISCORD_BOT_TOKEN, BACKEND_URL, BOT_API_SECRET (mesmo valor do server), DISCORD_DEV_GUILD_ID (opcional)
docker compose -f infra/docker-compose.yml up -d   # LiveKit local
npm run dev:server
npm run dev:bot
npm run dev:desktop
```

Gere o `BOT_API_SECRET` com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
O `.env.example` da raiz lista todos os nomes. Em produção o bot é um processo contínuo (no Render, um
*Background Worker*; um Web Service gratuito hiberna e o bot cairia junto).

O Discord só aceita botões com URL pública: com `PUBLIC_BASE_URL=http://localhost:8787` o bot manda o link
no texto em vez do botão. Para testar o botão de verdade, exponha o servidor com um túnel
(`cloudflared tunnel --url http://localhost:8787`) e use a URL https dele em `PUBLIC_BASE_URL`.

O protocolo `partilhartela://` é registrado pelo instalador (NSIS) e, em desenvolvimento, pelo próprio
Electron ao abrir (`app.setAsDefaultProtocolClient`).

### 4. Testar ponta a ponta

1. Crie um servidor de teste no Discord, convide o bot e defina `DISCORD_DEV_GUILD_ID` com o id dele
   (Modo desenvolvedor → clique direito no servidor → Copiar ID).
2. Suba LiveKit, server, bot e desktop (comandos acima). No log do bot deve aparecer `Bot conectado como ...`.
3. **Conta A** entra num canal de voz → no chat desse canal aparece a mensagem com o botão.
4. **Conta B** (outra conta, em outro PC ou no navegador com outro perfil) entra no mesmo canal de voz.
5. No PC da conta A: abra o app → **Entrar com Discord** → autorize no navegador → **Entrar na call atual**
   → **Compartilhar tela**.
6. Na conta B: clique no botão da mensagem (ou rode `/tela`) → a página `/join` abre o app → ele entra
   na sala e mostra a tela da conta A. Na lista de participantes e no palco aparecem nome e avatar do Discord.
   Sem o app, use **Assistir no navegador** (`WEB_APP_URL`) ou o código de 6 caracteres.
7. As duas contas saem do canal de voz → a mensagem vira "Sala encerrada" e o app volta ao início.

Para testar só com um PC: rode um segundo app desktop com outro perfil ou use o viewer web
(`npm run dev:web`) com o código mostrado na mensagem.

---

## 📁 Estrutura do Projeto

```text
COMPARTILHARTELAV2/
├── apps/
│   ├── desktop/            # Aplicação Desktop Electron + React
│   │   ├── src/main/       # Processo principal Electron e captura de áudio (loopback)
│   │   ├── src/preload/    # Bridge IPC segura com contextIsolation
│   │   ├── src/renderer/   # Interface React, conexão LiveKit e controles de transmissão
│   │   └── release/        # Pasta onde o instalador .exe é gerado
│   ├── server/             # API Fastify: tokens LiveKit, SQLite, login Discord, /join e API do bot
│   ├── bot/                # Bot do Discord (discord.js): sala por canal de voz e comando /tela
│   └── web/                # Interface web leve para espectadores assistirem via browser
├── infra/                  # Configurações de Docker Compose (LiveKit self-hosted opcional)
└── package.json            # Monorepo NPM Workspaces
```

---

## ✨ Recursos

- [x] Transmissão de vídeo de baixa latência em tempo real via WebRTC.
- [x] Captura de telas inteiras e janelas individuais.
- [x] Captura de áudio isolada por processo no Windows (evita eco e vazamento de Discord).
- [x] Ajuste dinâmico de qualidade (720p30, 1080p30, 1080p60).
- [x] Códigos de sala simples e rápidos de 6 dígitos.
- [x] Espectador web sem necessidade de download.
- [x] Suporte a aceleração de hardware GPU para codificação de vídeo.
- [x] Integração com o Discord: sala por canal de voz, botão no chat, `/tela`, login e avatares.

---

## 📄 Licença

Este projeto é privado e de uso livre para compartilhamento de tela pessoal e colaborativo.