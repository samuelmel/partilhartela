---
name: electron-ipc
description: Use ao criar, alterar ou remover qualquer canal IPC, API exposta em window.partilharTela, permissão de sessão, navegação, CSP ou opção de BrowserWindow no app desktop (apps/desktop/src/main e src/preload).
---

# IPC e segurança do Electron

A ponte renderer↔main é só `window.partilharTela`, definida em três lugares que precisam
ficar em sincronia:

| Arquivo | Papel |
|---|---|
| `apps/desktop/src/main/main.ts` | `ipcMain.handle('<area>:<acao>', ...)` dentro de `app.whenReady()` |
| `apps/desktop/src/preload/preload.ts` | `contextBridge.exposeInMainWorld('partilharTela', {...})` |
| `apps/desktop/src/renderer/vite-env.d.ts` | tipo de `Window['partilharTela']` usado pelo renderer |

## Adicionar um canal

1. Nome no padrão `desktop:*` (captura/janela/clipboard) ou `audio:*` (loopback).
2. No main, trate o argumento como `unknown` e valide (`typeof x === 'string'`,
   `Number.isInteger(pid) && pid > 0`). Em erro, `throw new Error('mensagem em pt-BR')` —
   a mensagem chega ao renderer na rejeição do `invoke`.
3. Recursos exclusivos do Windows: `if (process.platform !== 'win32') throw ...`.
4. No preload exponha uma função fina (`ipcRenderer.invoke(canal, arg)`). Nunca exponha
   `ipcRenderer` inteiro, `send` genérico ou módulos Node.
5. Eventos main→renderer (ex.: `audio:data`): `mainWindow?.webContents.send(...)` no main e,
   no preload, um `onX(listener)` que retorna a função de remoção (`removeListener`).
6. Atualize o tipo em `vite-env.d.ts` e rode `npm run typecheck`.

## Regras que não podem regredir

- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Navegação travada: `will-navigate` só aceita a URL do próprio app e
  `setWindowOpenHandler` nega novas janelas. Links externos, se um dia existirem, via `shell.openExternal` validado.
- Permissões (`setPermissionRequestHandler`/`CheckHandler`) só concedem `media` e `display-capture`.
- A CSP do renderer empacotado é injetada pelo plugin em `apps/desktop/vite.config.ts`
  (apenas no build, porque o Vite dev usa script inline). Novo domínio de rede → ajuste `connect-src` ali.
- `getDisplayMedia` só funciona depois de `setCaptureSource(id)`: o handler
  `setDisplayMediaRequestHandler` procura o id guardado em `selectedCaptureSourceId`.
