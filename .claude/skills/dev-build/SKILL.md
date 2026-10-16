---
name: dev-build
description: Use ao rodar, buildar ou verificar o PartilharTela localmente (app desktop Electron, servidor de tokens, viewer web, LiveKit local) ou antes de commitar qualquer mudança de código para confirmar que tudo compila.
---

# Rodar e verificar o PartilharTela

Todos os comandos na raiz do monorepo (`npm` workspaces).

## Ambiente local completo

1. `apps/server/.env` (nomes em `.env.example`; desktop e web leem `VITE_TOKEN_SERVER_URL` do
   próprio `apps/<app>/.env`). Para LiveKit local mantenha
   `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret`
   (casam com `infra/livekit.yaml`).
2. LiveKit: `docker compose -f infra/docker-compose.yml up -d` (portas 7880, 7881/tcp, 7882/udp).
   Sem Docker o app abre, mas criar/entrar na sala falha com "Servidor de mídia LiveKit indisponível".
3. `npm run dev` — sobe `tsx watch` do server (:8787), Vite (:5173, `strictPort`) e o Electron
   (espera o Vite com `wait-on`). DevTools abre sozinho em dev.
4. Viewer web: `npm run dev:web` → http://localhost:5174/?room=CODIGO.

Checagem rápida do server: `curl http://localhost:8787/health`.

## Verificação antes de commit

Não há lint nem testes. Rode, nesta ordem, e só considere pronto se tudo sair com código 0:

```bash
npm run typecheck
npm run typecheck:web
npm run build
npm run build:web
```

O aviso "Some chunks are larger than 500 kB" é esperado (livekit-client).

## Armadilhas

- Porta 5173 ocupada derruba o `dev` (strictPort). Mate o processo antigo do Vite/Electron.
- `loopback-capture` é nativo: depois de trocar a versão do Electron rode `npm install` de novo.
- Em dev o Electron carrega `http://localhost:5173`; empacotado carrega `apps/desktop/dist/index.html`
  (`app.isPackaged`). Mudanças de CSP/navegação precisam ser checadas nos dois caminhos.
- `VITE_TOKEN_SERVER_URL` é fixada no build: `npm run dist` usa `apps/desktop/.env.production`.
