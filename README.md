# StreamP2P — Compartilhamento de Tela P2P em HD

Monorepo com **duas aplicações** (Electron desktop + cliente web) e **dois pacotes** (configuração compartilhada + addon nativo de áudio WASAPI).

O vídeo vai direto de peer para peer via WebRTC/PeerJS, sem servidor de mídia. O áudio do sistema é capturado por um addon nativo C++ que **exclui o Discord por PID**, coisa que o Chromium não permite.

---

## 1. Arquitetura

```
streamp2p/
├── apps/
│   ├── desktop/                  # HOST em Electron
│   │   ├── main.js               # janela, desktopCapturer, PIDs, ponte do addon
│   │   ├── preload.js            # contextBridge (API mínima e explícita)
│   │   ├── index.html            # HTML canônico do produto
│   │   ├── smoke.js              # teste de integração do processo main
│   │   ├── css/style.css
│   │   └── js/
│   │       ├── config.js         # estado global
│   │       ├── ui.js             # DOM, toasts, modais, medidor
│   │       ├── audio-native.js   # PCM -> MediaStreamTrack
│   │       ├── webrtc.js         # PeerJS, captura, bitrate, replaceTrack
│   │       ├── app.js            # rotas e listeners
│   │       └── shared/           # cópia sincronizada de packages/shared
│   └── web/                      # RECEPTOR (HTML/JS puro, sem deps nativas)
│       ├── index.html            # gerado de apps/desktop/index.html
│       └── js/{config,ui,webrtc,app}.js + shared/
│
├── packages/
│   ├── shared/src/               # quality, signaling, utils, process-scan (UMD)
│   └── native-audio/             # addon C++ (N-API + WASAPI)
│       ├── binding.gyp
│       ├── index.js              # loader com fallback graceful
│       └── src/{audio_capturer.h,audio_capturer.cc}
│
├── scripts/
│   ├── sync-shared.js            # copia packages/shared -> apps/*/js/shared
│   ├── build-web-html.js         # gera apps/web/index.html a partir do desktop
│   ├── check-syntax.js           # valida sintaxe + estrutura de todos os scripts
│   └── serve.js                  # servidor estático local p/ apps/web
│
├── render.yaml                   # blueprint de deploy (Static Site)
└── package.json                  # npm workspaces
```

`packages/shared` é a fonte canônica. Como o renderer não usa bundler (scripts via `<script src>`), o `sync:shared` copia os arquivos para dentro de cada app.

---

## 2. Requisitos

| Item | Versão | Observação |
|---|---|---|
| Node.js | 18+ (testado com 24) | headers do Node 24 exigem **C++20** |
| npm | 9+ | usa workspaces |
| Windows | 11 21H2+ (build 20348+) | para o modo `EXCLUDE_TARGET_PROCESS_TREE` do WASAPI |
| Visual Studio Build Tools | 2022 com C++ e Windows SDK | **só para compilar o addon nativo** |
| Navegador | Chrome / Edge | Firefox tem restrição de áudio |

---

## 3. Comandos

| Comando | O que faz |
|---|---|
| `npm install` | Instala workspaces. **Não** compila o addon (ver §6) |
| `npm start` | Sobe o app Electron (dev) |
| `npm run start:web` | Serve `apps/web` em `http://127.0.0.1:5173` |
| `npm run check` | Valida sintaxe de todos os JS + estrutura dos HTML |
| `npm run probe:capture` | Testa as variantes de captura e detecta queda do renderer |
| `npm run smoke` | Testa os módulos do processo main (sem abrir janela) |
| `npm run sync:shared` | Sincroniza `packages/shared` para os apps |
| `npm run build:web` | Regenera `apps/web/index.html` a partir do desktop |
| `npm run build:native` | Compila o addon (contra o ABI do **Node**) |
| `npm run rebuild:native` | Recompila contra o ABI do **Electron** (use este) |
| `npm run pack` | Pacote descompactado em `dist/win-unpacked/` |
| `npm run dist` | Instalador NSIS + portátil em `dist/` |

Sempre rode `npm run check` antes de commitar: ele pega erro de sintaxe, script referenciado inexistente, HTML com `<div>` desbalanceado e mojibake.

---

## 4. Testar sozinho

**Opção A — Electron + navegador**
1. `npm start`, crie a sala
2. Copie o link (aponta para `WEB_APP_URL` em `apps/desktop/js/config.js`)
3. Abra no Chrome/Edge → entra como espectador

**Opção B — dois navegadores**
1. Abra `npm run start:web` em duas abas/ perfis
2. Crie a sala numa e entre com o link na outra

---

## 5. Deploy no Render

`apps/web` é site estático: sem build step, sem dependências. O `render.yaml` já define isso.

Configuração no painel (**Settings → Build**):

| Campo | Valor | Por quê |
|---|---|---|
| Root Directory | `apps/web` | Render roda tudo a partir daqui |
| Build Command | *(vazio)* | não há build; e evita instalar o Electron (~200 MB) |
| Publish Directory | `./` | relativo ao Root Directory |

**O erro mais comum aqui:** com `Root Directory = apps/web`, o Publish Directory tem de ser `./`. Se você colocar `apps/web`, o Render procura `apps/web/apps/web` e falha. E `stream-p2p` (a pasta da estrutura antiga) **não existe mais** — se ele estiver no Publish Directory, o deploy quebra.

Depois do primeiro deploy, atualize `WEB_APP_URL` em `apps/desktop/js/config.js` para a URL do Render.

> O addon nativo **não vai para o Render**. Ele é C++ e só funciona no app Electron. No navegador não existe forma de excluir um app do áudio do sistema.

**Caveat de sinalização:** sem `host` configurado, o PeerJS usa o broker público, que tem limite de ~4 peers por sala e instabilidade conhecida. Se a sala não conectar, o suspeito é o broker — não o código.

---

## 6. Addon nativo de áudio — **estado atual**

**Não compila ainda.** O código está escrito mas nunca passou pelo compilador com sucesso.

O que já foi diagnosticado e corrigido no build:
- include dir do `node-addon-api` (quebrado por **espaços no caminho** do projeto, que o MSBuild tokenizava)
- C++17 → **C++20** (headers do Node 24 exigem)

O que falta, segundo o SDK `10.0.26100` (`um/audioclientactivationparams.h`):

| Código atual | API real |
|---|---|
| só `audioclient.h` | precisa de `<audioclientactivationparams.h>` |
| `ProcessCount` + `ProcessIds[]` | `DWORD TargetProcessId` — **um PID por ativação** |
| `PROCESS_LOOPBACK_MODE_EXCLUDE` | `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` |
| `VIRTUAL_AUDIO_CAPTURE_PROCESS_LOOPBACK` | `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` + `ActivateAudioInterfaceAsync(LPCWSTR, ...)` |
| `prop.blob.cbData` | `BLOB` usa `cbSize` |

**A boa notícia:** o modo real é `EXCLUDE_TARGET_PROCESS_TREE` — excluir o PID **raiz** do Discord remove a árvore inteira de filhos. Existe um `Discord.exe` rodando aí com 6 processos; basta identificar o PID raiz (o cujo pai não é outro Discord) e ativar **uma** captura.

### Como compilar

1. Instale **Visual Studio Build Tools 2022** com:
   - "Desenvolvimento para Desktop com C++"
   - Windows 10/11 SDK
2. No diretório **sem espaços no caminho** (o MSBuild do gyp tokeniza mal):
   ```bash
   npm run build:native      # compila
   npm run rebuild:native    # rebuild contra o Electron
   ```

### Por que o build é manual

O `install` do pacote nativo é um no-op de propósito: `npm install` compilaria contra o ABI do Node, e o addon precisa do ABI do Electron. Além disso, o app tem **fallback graceful** — sem o binário, ele funciona igual, só sem o filtro de áudio do Discord. Um passo opcional não pode quebrar a instalação.

Status do fallback (verificado em `apps/desktop/smoke.js`):
```json
{"loaded":false,"supported":false,"build":26200,"requiredBuild":20348,
 "reason":"Binario nativo nao encontrado. Rode: npm run build:native"}
```

---

## 7. Como o áudio é isolado

1. `main.js` lista os PIDs do Discord via `tasklist` (zero dependências; `ps-list` seria brought down)
2. O renderer pede esses PIDs via IPC e inicia o addon com eles
3. O addon ativa o WASAPI em `EXCLUDE_TARGET_PROCESS_TREE` e entrega PCM s16 via ThreadSafeFunction
4. `main.js` reencaminha os pacotes ao renderer; `audio-native.js` monta um `AudioData` e escreve num `MediaStreamTrackGenerator`
5. A track entra na `MediaStream` enviada aos espectadores

Se o Discord **abrir ou fechar durante a transmissão**, basta reiniciar a captura — `replaceAudioTrackOnSenders()` troca a track nos senders existentes sem reconectar os espectadores.

Microfone: nunca entra na captura do sistema (o botão **Microfone** adiciona uma track separada, se você quiser).

**Limitação honesta:** não existe API no Windows para excluir um app de um *loopback* comum. O modo determinístico é o process-loopback do addon. No navegador isso é impossível.

---

## 8. Bug do "renderer morre" (`bad_message.cc, reason 263`)

**Sintoma:** a tela congela e o log mostra
`Terminating renderer for bad IPC message, reason 263`.

**Causa:** `getUserMedia` com **áudio de desktop isolado** derruba o renderer nesta
versão do Electron:

```js
// NUNCA fazer isso no Electron desktop:
getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: false })
```

**Confirmado empiricamente** com `npm run probe:capture`:

| Variante | Resultado |
|---|---|
| vídeo apenas | ✅ `video=1 audio=0` |
| áudio + vídeo juntos, mesmo `sourceId` | ✅ `video=1 audio=1` |
| áudio isolado | 💀 renderer `crashed`, exit 3 |

**Correção:** o áudio sempre entra na mesma chamada do vídeo, amarrado ao
`chromeMediaSourceId` da fonte escolhida. Se a chamada com áudio falhar, o app
recae para vídeo apenas (`apps/desktop/js/webrtc.js`, bloco `resolveAudioStrategy`
+ `card.onclick`). O teste C do probe está comentado de propósito: descomentar
reproduz o crash.

## 9. Sobre os TURN do PeerJS

```
Failed to resolve address for eu-0.turn.peerjs.com
```

Esses hostnames vêm da configuração interna do PeerJS, injetada pelo PeerServer —
**não** da lista `iceServers` que passamos. Não há como removê-los pelo lado do
cliente. São logs ruidosos, e na prática não impedem nada: com host e viewer na
**mesma máquina**, o ICE resolve por candidatos host, sem TURN. Se a sala não
conectar, o suspects é o limite do broker público do PeerJS, não a config de ICE.

`packages/shared/src/signaling.js` já usa apenas STUN (Google + Twilio).

---

## 10. Áudio do sistema no fallback — o que é verdade

Medido com `npm run probe:capture` nesta máquina:

| Variante | deviceId | canais | EC/AGC/NS |
|---|---|---|---|
| `getUserMedia` áudio+vídeo, `sourceId` = tela | `loopback` | 2 | desligados |
| `getUserMedia` áudio+vídeo, `sourceId` = **janela** | `loopback` | 2 | desligados |
| `getDisplayMedia` + handler Electron | `loopback` | **1** | **ligados** |

Duas conclusões que contrariam a intuição:

1. **O fallback já captura áudio global.** No Electron o Chromium ignora o
   `chromeMediaSourceId` do áudio e sempre devolve o loopback do dispositivo de
   saída padrão (`deviceId: "loopback"`). Amarrar o áudio a uma janela **não**
   restringe o áudio aquela janela.
2. **Trocar para `getDisplayMedia` seria uma regressão.** O handler entrega a
   mesma faixa em mono e com cancelamento de eco, supressão de ruído e AGC
   **ligados** — o que degrada áudio de jogo e música.

### "O espectador não escuta nada" — causa provável

Não é a captura. Duas causas reais, na ordem de probabilidade:

1. **Política de autoplay do Chrome.** O stream chega, mas o áudio só toca após
   um gesto do usuário. A UI agora mostra um overlay **"Clique para ativar o
   áudio"** quando o playback é recusado (`setupAudioUnlock()` em `ui.js`).
2. **Som em outro dispositivo de saída.** O loopback captura apenas o
   dispositivo de saída **padrão** do Windows. Se o YouTube toca em fone
   enquanto o padrão são as caixas, não entra. Não há como contornar sem o
   addon nativo.

Diagnóstico rápido: abra o DevTools no espectador e veja o log
`[audio] track recebida: ... deviceId=loopback`. Se aparecer, o áudio chegou e o
problema é autoplay. Se não aparecer, o host não mandou faixa de áudio.

---

## 11. Problemas comuns

| Problema | Causa / solução |
|---|---|
| `Publish directory ... does not exist` | Publish Directory é `./` (não `apps/web`), e `stream-p2p` não existe mais |
| `npm install` falhou com erro de gyp | Afaste-se de caminhos com espaço, ou mantenha o build como opt-in (§6) |
| Sala não conecta | Limite do broker público do PeerJS |
| Áudio do Discord na transmissão | Adon não compilado ainda (§6); sem ele o app não isola |
| Sem áudio no espectador | Política de autoplay do Chrome → clique no overlay "Clique para ativar o áudio" |
| Áudio do sistema não entra | O loopback só captura o dispositivo de saída **padrão** |
| Firefox sem áudio de tela | Limitação do Firefox — use Chrome/Edge |
| Erro de sintaxe após editar HTML | Rode `npm run check` |