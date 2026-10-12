# PartilharTela

Aplicativo desktop para compartilhamento de tela ao vivo, com baixa latência, usando Electron, React, TypeScript, WebRTC e LiveKit. A interface e as mensagens do produto estão em português do Brasil.

## 🚀 Deploy no Render (Recomendado para produção)

Para deploy fácil e gratuito no [Render](https://render.com):

### Pré-requisitos
- Conta no [Render](https://render.com)
- Conta no [GitHub](https://github.com) (este repositório deve estar no GitHub)
- Conta no [LiveKit Cloud](https://cloud.livekit.io) (gratuito para começar)

### Passo a passo para deploy

#### 1. Configure o LiveKit Cloud
1. Acesse [LiveKit Cloud](https://cloud.livekit.io) e faça login
2. Crie um novo projeto
3. Copie as credenciais:
   - **URL**: algo como `wss://seu-projeto.livekit.cloud`
   - **API Key**: `APIKey...`
   - **API Secret**: `APISecret...`

#### 2. Faça fork deste repositório
- Faça fork deste repositório no GitHub para sua conta

#### 3. Crie o serviço no Render
1. No Render dashboard, clique em "New +"
2. Escolha "Web Service"
3. Conecte seu repositório forkado
4. Configure:
   - **Name**: `partilhartela` (ou outro nome de sua escolha)
   - **Region**: Escolha a região mais próxima de seus usuários
   - **Branch**: `main`
   - **Build Command**: `npm ci && npm run build:web`
   - **Publish Directory**: `apps/web/dist`

#### 4. Configure as variáveis de ambiente
No Render, vá para "Environment" e adicione:
- **Key**: `VITE_TOKEN_SERVER_URL`
- **Value**: `https://seu-service-name.onrender.com` (substitua pelo URL do seu serviço)

#### 5. Deploy do backend (opcional, para controle total)
Para controle total, você também pode deployar o backend:

1. Crie outro "Web Service" no Render
2. Mesmo repositório
3. **Build Command**: `npm ci && npm run build:server`
4. **Publish Directory**: `apps/server/dist`
5. Variáveis de ambiente:
   - `LIVEKIT_URL`: sua URL do LiveKit Cloud
   - `LIVEKIT_API_KEY`: sua API Key do LiveKit
   - `LIVEKIT_API_SECRET`: sua API Secret do LiveKit
   - `SERVER_PORT`: `10000` (Render usa essa porta por padrão)

#### 6. Teste seu deployment
- Acesse: `https://seu-service-name.onrender.com`
- O aplicativo web estará disponível para espectadores
- Para transmissão, continue usando o aplicativo Electron localmente

## 🖥️ Uso Local (Desenvolvimento)

### Pré-requisitos

- Windows 10/11 (prioridade), Node.js 20 ou superior e npm 10+.
- Docker Desktop com Compose.
- Uma GPU/driver atualizado é recomendado para codificação H.264 por hardware. O Chromium faz fallback para software quando NVENC, AMF ou QuickSync não estiver disponível.

### Etapa 1 — LiveKit e servidor de tokens

1. Opcionalmente, copie `.env.example` para `.env` na raiz. O backend já usa os valores locais (`devkey`/`secret`) quando esse arquivo não existe:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Suba o servidor de mídia:

   ```powershell
   docker compose -f infra\docker-compose.yml up -d
   ```

3. Instale as dependências:

   ```powershell
   npm install
   ```

4. Execute `npm run dev:desktop`; ele inicia automaticamente a API e o Electron. Depois, verifique `http://localhost:8787/health`: a resposta deve ser `{"ok":true}`.

   Se aparecer `could not establish signal connection: Failed to fetch`, a API de tokens está funcionando, mas o LiveKit não está disponível. Inicie o Docker Desktop e confirme:

   ```powershell
   docker compose -f infra\docker-compose.yml up -d
   docker compose -f infra\docker-compose.yml ps
   ```

   O container `livekit` deve aparecer como `running` e as portas `7880/tcp`, `7881/tcp` e `7882/udp` devem estar publicadas.

   O backend mantém as salas criadas em memória durante o processo. Para produção, substitua esse armazenamento por Redis/Postgres ou use a API de salas do LiveKit, permitindo várias instâncias da API sem perder salas após reinício.

### Etapa 2 — Aplicativo Electron

O comando abaixo inicia automaticamente a API, o Vite e o Electron:

```powershell
npm run dev:desktop
```

Também é possível iniciar tudo com `npm run dev`. Não é necessário executar `npm run dev:server` separadamente quando usar um desses comandos.

Para abrir uma segunda instância na mesma máquina, execute novamente `npm run dev:desktop` em outro terminal. Ela reutiliza o Vite que já está na porta 5173; a tentativa de iniciar uma segunda API é inofensiva, pois a primeira API continua atendendo as duas janelas.

O primeiro botão cria uma sala e o apresentador recebe um código de seis caracteres. O segundo botão pede o código e um apelido para entrar na sala. Qualquer participante pode clicar em **Compartilhar tela** e publicar uma tela; ninguém começa a transmitir automaticamente.

### Teste com duas instâncias na mesma máquina

1. Suba o LiveKit e a API conforme a etapa 1.
2. Execute `npm run dev:desktop`.
3. Crie uma sala, selecione uma tela ou janela e clique na miniatura. Em **Áudio**, use **Áudio da janela escolhida (Windows)** para capturar somente o processo da janela selecionada, sem trazer o áudio do Discord ou do próprio PartilharTela. **Áudio de todo o sistema** continua disponível como fallback, mas captura todos os sons do Windows.
4. Abra uma segunda instância executando novamente `npm run dev:desktop` em outro terminal, ou execute o instalador gerado em paralelo.
5. Informe o código na segunda instância e confirme que o vídeo aparece. Teste trocar a fonte e alterar 720p30/1080p30/1080p60 sem desconectar a sala.
6. Para testar o erro de sala, use um código aleatório que não foi criado: a API responde “Sala inexistente ou expirada”.

## 📱 Versão web para espectadores

O workspace `apps/web` é uma versão somente para assistir. O apresentador continua usando o aplicativo Electron, mas o espectador pode entrar pelo navegador sem instalar nada.

Para testar localmente, mantenha a API em `http://localhost:8787` e execute:

```powershell
npm run dev:web
```

Abra `http://localhost:5174`, informe o código da sala e um apelido. Também é possível abrir diretamente:

```text
http://localhost:5174/?room=ABC123
```

## 🔨 Build e instalador Windows

```powershell
npm run typecheck
npm run build
npm run dist
```

O instalador NSIS `.exe` será criado em `apps\desktop\release`. O segredo `LIVEKIT_API_SECRET` nunca é empacotado no aplicativo; somente o backend o lê.

## ☁️ Produção com LiveKit Cloud

1. Crie um projeto em [LiveKit Cloud](https://cloud.livekit.io) e copie a URL WebSocket, API key e API secret.
2. Hospede `apps/server` em uma VPS/serviço Node com HTTPS e defina `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` e `SERVER_PORT`.
3. No build do desktop, defina `VITE_TOKEN_SERVER_URL` para a URL HTTPS da API. Nunca coloque a API secret no `.env` do desktop.
4. Libere somente o endpoint de tokens pela internet, ative HTTPS, mantenha o rate limit e configure logs/monitoramento.

## 💻 LiveKit self-hosted em VPS

Execute o Compose em uma VPS com IP público, configure domínio/TLS e os ports TCP/UDP exigidos pelo LiveKit. Em ambientes distribuídos, configure Redis e substitua a lista de salas em memória por persistência. Para produção séria, o LiveKit Cloud reduz a manutenção de TURN, certificados e escalabilidade.

## 📁 Estrutura

```text
apps/
  server/       API Fastify de salas e tokens
  desktop/
    src/main/   processo Electron e desktopCapturer
    src/preload/bridge IPC com contextIsolation
    src/renderer/React, LiveKit e interface
  web/          Versão web para espectadores (somente visualização)
infra/          Docker Compose e configuração LiveKit
```

## 🎯 Melhorias futuras

- Versão web para espectadores sem instalação.
- Vários apresentadores e transferência de controle.
- Gravação da transmissão e replay.
- Senha opcional por sala, persistência de salas e autenticação.
- Métricas WebRTC medidas no overlay (RTT, resolução, FPS, bitrate e encoder reportado pelo navegador).
- Suporte a múltiplos monitores na captura de tela.
- Controle de qualidade adaptativa baseado na banda detectada.

## 📞 Suporte e contribuições

Para reportar bugs ou solicitar funcionalidades, abra uma issue neste repositório. Pull requests são bem-vindas!

---

🤖 **Gerado com [Claude Code](https://claude.com/claude-code)**