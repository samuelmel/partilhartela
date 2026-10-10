# PartilharTela

Aplicativo desktop para compartilhamento de tela ao vivo, com baixa latência, usando Electron, React, TypeScript, WebRTC e LiveKit. A interface e as mensagens do produto estão em português do Brasil.

## Pré-requisitos

- Windows 10/11 (prioridade), Node.js 20 ou superior e npm 10+.
- Docker Desktop com Compose.
- Uma GPU/driver atualizado é recomendado para codificação H.264 por hardware. O Chromium faz fallback para software quando NVENC, AMF ou QuickSync não estiver disponível.

## Etapa 1 — LiveKit e servidor de tokens

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

## Etapa 2 — Aplicativo Electron

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

## Performance e qualidade

- `backgroundThrottling: false`, aceleração de GPU e rasterização GPU são configurados na janela Electron.
- O LiveKit usa `adaptiveStream` e `dynacast`; camadas simulcast na tela estão desativadas por estabilidade do H.264 no Electron.
- Para evitar quadros pretos observados em algumas combinações Electron/Chromium com H.264, a publicação atual da tela usa simulcast desativado.
- As opções limitam a captura a 1280x720@30, 1920x1080@30 ou 1920x1080@60, com bitrates-alvo de 4/8/12 Mbps; o bitrate efetivo depende da estimativa de banda do WebRTC.
- O codec publicado é preferencialmente H.264; a negociação WebRTC pode cair para VP8/VP9 conforme o hardware e o navegador remoto.
- O seletor **Movimento / jogos** define `contentHint = "motion"` e `degradationPreference = "maintain-framerate"`. Para texto e código, **Texto / código** usa `detail` e preserva a resolução.
- Reconexão e retomada de publicação são oferecidas pela camada LiveKit; se a sessão não puder ser recuperada, o app informa claramente que a conexão foi perdida.

### Áudio por aplicativo no Windows

O modo **Áudio da janela escolhida (Windows)** usa o pacote `loopback-capture`, baseado em WASAPI Process Loopback, e converte o PCM recebido em uma faixa WebRTC por `AudioWorklet`. Ele exige Windows 10 x64 ou superior e uma janela cujo PID possa ser associado pelo sistema. A captura de uma tela inteira não possui um processo único; nesse caso use o modo de áudio do sistema ou selecione a janela do aplicativo.

O modo **Sistema, exceto um processo (Windows)** usa `start(processId, false, ...)`: no Windows, `false` ativa a exclusão da árvore do processo indicado. A tela de configuração lista as janelas detectadas para você escolher o processo (Discord, navegador ou outro); o modo por aplicativo continua sendo a opção mais isolada.

## Build e instalador Windows

```powershell
npm run typecheck
npm run build
npm run dist
```

O instalador NSIS `.exe` será criado em `apps\desktop\release`. O segredo `LIVEKIT_API_SECRET` nunca é empacotado no aplicativo; somente o backend o lê.

## Produção com LiveKit Cloud

1. Crie um projeto em [LiveKit Cloud](https://cloud.livekit.io) e copie a URL WebSocket, API key e API secret.
2. Hospede `apps/server` em uma VPS/serviço Node com HTTPS e defina `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` e `SERVER_PORT`.
3. No build do desktop, defina `VITE_TOKEN_SERVER_URL` para a URL HTTPS da API. Nunca coloque a API secret no `.env` do desktop.
4. Libere somente o endpoint de tokens pela internet, ative HTTPS, mantenha o rate limit e configure logs/monitoramento.

### LiveKit self-hosted em VPS

Execute o Compose em uma VPS com IP público, configure domínio/TLS e os ports TCP/UDP exigidos pelo LiveKit. Em ambientes distribuídos, configure Redis e substitua a lista de salas em memória por persistência. Para produção séria, o LiveKit Cloud reduz a manutenção de TURN, certificados e escalabilidade.

## Estrutura

```text
apps/
  server/       API Fastify de salas e tokens
  desktop/
    src/main/   processo Electron e desktopCapturer
    src/preload/bridge IPC com contextIsolation
    src/renderer/React, LiveKit e interface
infra/          Docker Compose e configuração LiveKit
```

## Melhorias futuras

- Versão web para espectadores sem instalação.
- Vários apresentadores e transferência de controle.
- Gravação da transmissão e replay.
- Senha opcional por sala, persistência de salas e autenticação.
- Métricas WebRTC medidas no overlay (RTT, resolução, FPS, bitrate e encoder reportado pelo navegador).
