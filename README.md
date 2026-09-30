# StreamP2P — Compartilhamento de Tela P2P em HD

Aplicativo Desktop (Electron) + versão Web de compartilhamento de tela **Peer-to-Peer** via WebRTC/PeerJS. Sem servidor de vídeo intermediário: o vídeo vai direto de navegador para navegador com criptografia DTLS/SRTP.

- **Qualidade:** até 1080p @ 60 FPS (presets: Padrão, Jogo, Filme, Personalizado)
- **Áudio:** captura do áudio do sistema com filtro opcional que isola o som do Discord
- **Sinalização:** PeerJS (IDs no formato `streamp2p-room-<codigo>`)
- **Estados:** `isHost`, `isSharing`, `localStream`, `activeDataConns` (ver `js/config.js`)

---

## 1. Requisitos

| Item | Versão |
|---|---|
| Node.js | 18+ (testado com 24) |
| npm | 9+ |
| Windows | 10/11 (build `electron-builder --win`) |
| Navegador (modo web) | Chrome / Edge (recomendado), Firefox funciona com restrições de áudio |

---

## 2. Instalação

```bash
npm install
```

> Só há dependências de **desenvolvimento** (`electron` e `electron-builder`). As libs de frontend (Tailwind, PeerJS, Lucide, fontes) entram por CDN direto no `index.html` — por isso não existem em `dependencies`.

---

## 3. Comandos npm

| Comando | O que faz |
|---|---|
| `npm start` | Sobe o app Electron a partir do código (`electron .`) — **modo desenvolvimento** |
| `npm run pack` | Gera uma versão descompactada em `dist/win-unpacked/` (testar sem instalar) |
| `npm run dist` | Gera os instaladores finais do Windows em `dist/` |

### Saídas do `npm run dist`

```
dist/
├── StreamP2P Setup 1.0.0.exe      # instalador NSIS (com passo a passo)
├── StreamP2P 1.0.0.exe            # versão portátil (roda sem instalar)
├── StreamP2P Setup 1.0.0.exe.blockmap
├── latest.yml
└── win-unpacked/                  # app descompactado
```

Para empacotar **outros sistemas** altere o bloco `build.targets` em `package.json`:

```json
"win": { "target": ["nsis", "portable"] }
```

Adicione, por exemplo, `"mac": { "target": ["dmg"] }` ou `"linux": { "target": ["AppImage"] }`.

---


## 5. Como funciona o fluxo

1. **Criar sala** → gera código de 8 caracteres (`crypto.randomUUID().slice(0, 8)`) e navega para `index.html?sala=<codigo>`.
2. **Host** → cria um PeerJS com ID `streamp2p-room-<codigo>`. Se o ID já estiver em uso, o mesmo código cai automaticamente para o modo espectador (`unavailable-id`).
3. **Compartilhar** → `getDisplayMedia()` no navegador ou seletor nativo do Electron (com detecção do Discord).
4. **Espectador** → abre o link com `?sala=<codigo>`, conecta via `peer.connect(hostPeerId)` e recebe a chamada WebRTC (`call.on('stream')`).
5. **Bitrate adaptativo** → monitor a cada 4s (`startAdaptiveBitrateMonitor`) reduz/recupera o bitrate conforme perda de pacotes.

---

## 6. Como testar (sozinho)

A forma mais simples de testar sem segunda máquina:

**Opção A — Electron + navegador (recomendado)**
1. Rode `npm start` e crie a sala no app.
2. Copie o link gerado (aponta para `https://streamp2p-zsv7.onrender.com/index.html?sala=...`).
3. Abra o link no Chrome/Edge → ele entra automaticamente como **espectador**.
4. Clique em *Iniciar Compartilhamento* no app.

**Opção B — Dois navegadores**
1. Abra a página sem `?sala=` e clique em *Criar Nova Sala* (abas anônimas ajudam).
2. Copie o link e abra em outra aba/perfil.

**Opção C — Dois Electron**
```bash
npm start
```
(basta iniciar duas instâncias com a mesma sala — a segunda vira espectador)

> Dica: `F12` → aba **Console** mostra os logs de conexão (`Novo espectador conectado...`, `Stream de mídia recebido...`).

---

## 7. Modo x Modo: Electron vs Navegador

| Recurso | Electron (exe) | Navegador (web) |
|---|---|---|
| Captura de tela | `desktopCapturer` + seletor nativo com miniaturas | `navigator.mediaDevices.getDisplayMedia()` |
| Áudio do sistema | Loopback forçado (`setDisplayMediaRequestHandler`) | Depende do que o navegador oferecer no prompt |
| Isolamento de Discord | Sim (detecta processos via `tasklist`, isola áudio por janela) | Não disponível |
| Microfone | Sim | Sim |
| Flags de GPU | `ignore-gpu-blocklist`, `force_high_performance_gpu`, etc. | Usa config padrão do navegador |

---

## 8. Variáveis e constantes

| Constante | Arquivo | Descrição |
|---|---|---|
| `WEB_APP_URL` | `js/config.js` | URL pública usada no link compartilhável gerado pelo app desktop |
| `qualityConfig` | `js/config.js` | Resolução/fps/bitrate/contentHint atuais (padrão 1080p60 @ 3.5 Mbps) |
| `PRESETS` | `js/config.js` | `default`, `jogo`, `filme` |
| `peer` | `js/config.js` | Instância PeerJS ativa |

---

## 9. Isolamento de áudio (Discord e microfone)

### Por que o Discord vazava antes

O áudio era capturado **sem `chromeMediaSourceId`** (`audio: { mandatory: { chromeMediaSource: 'desktop' } }`). Isso faz o Chromium devolver o **loopback do sistema inteiro** — a mixagem completa da sua placa de som, Discord incluído. Como o loopback sempre devolve uma track de áudio, o `break` do laço de "isolamento" disparava na primeira janela testada e o filtro nunca era aplicado.

### O que foi corrigido

| Cenário | Antes | Agora |
|---|---|---|
| Tela cheia + "Sistema Limpo" | Loopback do sistema (Discord vazava) | Áudio por janela, com `chromeMediaSourceId`. Sem áudio isolado → **fica sem áudio**, nunca com loopback |
| Captura de janela | Loopback do sistema (Discord vazava) | Áudio **só daquela janela** (`chromeMediaSourceId` da janela) |
| Capturar a janela do Discord | Permitido | **Bloqueado** com aviso |
| `main.js` handler | Forçava `audio: 'loopback'` sempre | Só anexa loopback se o renderer pediu (`request.audioRequested`) |

O microfone também fica fora automaticamente: ele nunca entra na captura por janela. Se quiser o microfone, use o botão **Microfone** da barra de ferramentas (ele é adicionado como track separada).

### Ordenação de tentativas do áudio isolado (tela cheia)

1. Janelas sem Discord e sem ser o próprio StreamP2P (até 8)
2. Cada tentativa tem **timeout de 1,2 s** — uma janela travada não segura o processo
3. Nenhumavento com som → segue sem áudio e avisa (nunca cai em loopback)

### Limitação real do Windows

Não existe API no Windows para excluir um app específico de uma captura *loopback*. Por isso o app usa captura **por janela**, que é a única forma determinística. Se você quiser o áudio de tela cheia com TODO o som do PC (inclusive Discord), selecione **"Todo o Som do PC"** no seletor — aí é loopback de propósito.

Complemento opcional no OS: Som → **Gravação** → Microfone → Propriedades → **Escutar** → "Não escutar".

## 10. Travamentos corrigidos

| Travamento | Causa | Correção |
|---|---|---|
| Congela ao escolher "Tela Inteira" | Laço `for` chamava `getUserMedia` para **cada janela aberta**, sem timeout, cada uma disparando captura de desktop completa | `withTimeout()` em todas as capturas + limite de 8 candidatas |
| Congela do nada durante a transmissão | `setupAudioMeter` criava um novo `MediaStreamSource` a cada chamada sem desconectar o anterior | Desconecta o source anterior e retoma `AudioContext` suspenso |
| Travamento de tracks órfãs | Se a captura da tela falhasse no meio, as tracks ficavam ativas | `stopAllTracks()` no `catch` e em resoluções tardias (`onLateResolve`) |
| Travamento no navegador | `displaySurface: "monitor"` + timeout de 15 s (seção 12) | — |

---

## 11. Deploy da versão Web

A pasta `stream-p2p/` é a cópia publicada no Render (`WEB_APP_URL = https://streamp2p-zsv7.onrender.com`).

Para atualizar a versão web:

1. Copie os arquivos alterados para dentro de `stream-p2p/`:
   ```bash
   xcopy /E /Y js stream-p2p\js
   xcopy /E /Y css stream-p2p\css
   copy /Y index.html stream-p2p\index.html
   ```
2. Faça o deploy dessa pasta no Render (ou reenvie via git).

> Se alterou `js/*.js`, lembre-se de refletir a mudança em `stream-p2p/js/` — o desktop usa a raiz, a web usa a cópia.

---

## 12. Segurança

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: false` (necessário para o preload de captura).
- Comunicação só via `ipcRenderer.invoke` / `ipcMain.handle`.
- Sem armazenamento de dados em servidor — tudo é P2P.

---

## 13. Problemas comuns

| Problema | Causa / Solução |
|---|---|
| `ID do Host já ocupado` | Outra pessoa (ou outra aba) já usa a mesma sala — na prática isso **conecta como espectador** |
| Firefox não capta áudio de tela inteira | Limitação do Firefox — usar Chrome/Edge |
| Tela travada no navegador | `displaySurface: "monitor"` removido + timeout (seção 10) |
| Voz do Discord na transmissão | Use "Sistema Limpo (Sem Discord)" — a captura é por janela (seção 9) |
| Tela cheia sem áudio | Nenhum app tocando som. Se quiser TODO o som, escolha "Todo o Som do PC" |
| Travamento ao escolher Tela Inteira | Corrigido com timeouts (seção 10). Reinicie o app para pegar a versão nova |
| Sem áudio no espectador | Chrome exige que o espectador clique para ativar o som (autoplay policy) |
| `npm run dist` falha | Verifique se `electron-builder` está instalado: `npm install` |
| Link da sala não abre a sala | O link precisa conter `?sala=<codigo>` — lembre-se de subir o `stream-p2p/` atualizado no Render |
