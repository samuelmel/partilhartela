# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem [SemVer](https://semver.org/lang/pt-BR/).

## [1.2.1] - 2026-10-18

### Visual

- **desktop e web**: logo trocado pelo Patrick com o galão na cabeça (ícone do instalador, da janela, favicon e cabeçalho), agora com fundo transparente.

## [1.2.0] - 2026-10-18

### Novidades

- **desktop e web**: novo logo do app (ícone do instalador, da janela, favicon da web e marca no cabeçalho).
- **desktop e web**: som de aviso, no estilo do Discord, quando alguém começa ou para de compartilhar a tela. Trocar qualidade ou codificador durante a transmissão não toca nada.
- **desktop**: escolha do codificador de vídeo (H.264, VP8, VP9, AV1) na engrenagem do dock, filtrada pelo que o computador consegue enviar.
- **desktop**: estatísticas de quem transmite mostram FPS da captura, motivo de limitação de qualidade, tempo de codificação e banda disponível.

## [1.1.0] - 2026-10-16

### Novidades

- **web**: transmissão de tela direto do navegador (criar sala, entrar por código ou link `?room=`, compartilhar a tela). Som da aba ou do sistema no Chrome e no Edge; celulares e navegadores sem suporte ficam só assistindo, com explicação.
- **web**: página inicial com comparação navegador × app e botão "Baixar para Windows" apontando para as Releases.
- **desktop e web**: novo visual das salas, com código da sala em destaque, lista de quem transmite e assiste, painel de conexão e dock de transmissão.
- **desktop e web**: quem transmite pode mutar e desmutar o som sem parar o vídeo.
- **desktop e web**: cada espectador ajusta o próprio volume (0–100%) e muta o som só para si.
- **desktop**: botão "Sair da sala"; trocar o som ou a qualidade durante a transmissão já aplica.

### Correções

- **desktop**: botão de tela cheia não funcionava (o Electron negava a permissão `fullscreen`); Esc agora sai da tela cheia.
- **desktop**: títulos de janela com acento ou emoji apareciam como `?`, o que também atrapalhava a detecção do áudio por aplicativo.
- **desktop**: fechar a janela transmitida encerra também o áudio capturado.

### Manutenção

- **server**: tokens só permitem publicar a tela e o áudio dela (`canPublishSources`).
- Componentes de sala compartilhados em `shared/ui/` e teste ponta a ponta da web (`npm run test:e2e:web`).

## [1.0.4] - 2026-10-16

### Correções

- **desktop**: bloqueia navegação para fora do app e abertura de novas janelas no Electron.
- **desktop**: adiciona Content-Security-Policy ao renderer empacotado.
- **desktop**: libera `AudioContext` e listener IPC ao parar o áudio por aplicativo/exclusão (vazava a cada troca de fonte ou qualidade).
- **desktop**: limpa o intervalo de estatísticas WebRTC quando a conexão com a sala falha.
- **desktop**: aviso de conexão perdida passa a aparecer também para quem criou a sala.
- **server**: encerra com erro se `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` faltarem com `NODE_ENV=production` (antes usava as chaves de desenvolvimento).
- **server**: códigos de sala expiram após 12 horas em vez de acumular na memória para sempre.
- **web**: sair da sala não mostra mais "Conexão perdida"; tentativa de conexão que falha desconecta a sala correta.

### Documentação

- `CLAUDE.md` com visão geral, comandos, variáveis de ambiente e fluxo do projeto.

### Manutenção

- Skills do Claude Code em `.claude/skills` (`dev-build`, `electron-ipc`, `livekit-flow`, `release-desktop`).
