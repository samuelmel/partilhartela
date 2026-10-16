# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem [SemVer](https://semver.org/lang/pt-BR/).

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
