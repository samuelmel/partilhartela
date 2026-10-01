# StreamP2P

Compartilhamento de tela em HD, **peer-to-peer**, sem servidor de mídia.

O vídeo e o áudio do sistema viajam direto do host para o espectador via WebRTC. O diferencial: o áudio é capturado por um **addon nativo (C++/WASAPI)** que **exclui o Discord por PID** — o que o Chromium não permite.

- **Host:** app Electron (captura de tela + áudio isolado)
- **Espectador:** cliente web leve (HTML/JS puro, sem dependências)
- **Servidor de mídia:** nenhum. Só sinalização.

---

## Requisitos

| Item | Versão |
|---|---|
| Node.js | 18+ (testado com 24) |
| Windows | 11 21H2+ (build 20348+) — para o isolamento de áudio |
| Navegador | Chrome ou Edge (o Firefox não captura áudio de tela) |
| Visual Studio Build Tools 2022 | só para compilar o addon nativo (C++ + Windows SDK) |

---

## Como usar

### 1. Instalar

```bash
npm install
```

### 2. Subir o app desktop (host)

```bash
npm start
```

Crie a sala e copie o link de acesso. Para quem assiste, a URL vem de `WEB_APP_URL` em `apps/desktop/js/config.js`.

### 3. Assistir

Abra o link no Chrome ou Edge. Se o navegador bloquear o som, clique no overlay **"Clique para ativar o áudio"**.

### Testar só com o cliente web

```bash
npm run start:web
```

Sobe `apps/web` em `http://127.0.0.1:5173`. Abra em duas abas: crie a sala numa e entre pelo link na outra.

---

## Isolamento do áudio do Discord (módulo nativo)

O Windows não oferece nenhuma API para excluir um aplicativo do áudio de um *loopback* comum. O addon nativo usa o **process-loopback do WASAPI** para capturar o áudio do sistema **menos** a árvore de processos do Discord.

Como funciona:

1. O app identifica o PID raiz do Discord
2. O addon ativa o WASAPI em modo de exclusão e entrega PCM ao Electron
3. O áudio entra na mesma stream do vídeo, sem passar pelo microfone

**É opcional.** Sem o binário compilado, o app funciona normalmente — só sem o filtro de áudio do Discord. A API do WASAPI exclui **um** processo por vez (a árvore de filhos vai junto).

Se o Windows não disponibilizar o isolamento (build antigo ou driver que não expõe a interface virtual), o addon **cai automaticamente para o loopback do dispositivo de saída**: você continua transmitindo áudio do sistema, mas **sem** excluir o Discord. A interface deixa isso explícito no badge e no aviso exibido ao iniciar a captura.

### Compilar

```bash
npm run rebuild:native
```

Pré-requisito: **Visual Studio Build Tools 2022** com o workload *Desenvolvimento para Desktop com C++* e o Windows SDK.

| Comando | O que faz |
|---|---|
| `npm run rebuild:native` | compila o addon para o Electron |
| `npm run build:native` | compila o addon para o Node |

O build é manual de propósito: um passo opcional não pode quebrar a instalação.

---

## Deploy do cliente web

`apps/web` é site estático — sem build, sem dependências. O `render.yaml` já está pronto.

No painel do Render (**Settings → Build**):

| Campo | Valor |
|---|---|
| Root Directory | `apps/web` |
| Build Command | *(vazio)* |
| Publish Directory | `./` |

> Com `Root Directory = apps/web`, o Publish Directory é **relativo a ele**. Usar `apps/web` faz o Render procurar `apps/web/apps/web` e o deploy falha.

Depois do primeiro deploy, aponte `WEB_APP_URL` em `apps/desktop/js/config.js` para a URL do Render.

O addon nativo **não vai para o Render** — ele é C++ e só existe no app Electron. No navegador não há como isolar o áudio do Discord.

---

## Troubleshooting

| Problema | Solução |
|---|---|
| Áudio do Discord aparece na transmissão | Adon não compilado — rode `npm run rebuild:native`. Se o badge mostrar "sem filtro do Discord", o Windows não disponibilizou o isolamento; o áudio do sistema continua sendo transmitido |
| Espectador não ouve nada | Política de autoplay do Chrome: clique no overlay "Clique para ativar o áudio" |
| Áudio do sistema não entra | O loopback captura apenas o dispositivo de saída **padrão** do Windows |
| Firefox sem áudio de tela | Limitação do Firefox — use Chrome ou Edge |
| Sala não conecta | Limite e instabilidade do broker público do PeerJS. Na mesma máquina o ICE resolve por candidatos host |
| `Publish directory ... does not exist` | Publish Directory deve ser `./`, não `apps/web` |
| Erro de sintaxe após editar HTML | Rode `npm run check` antes de commitar |

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm start` | Sobe o app Electron |
| `npm run start:web` | Serve o cliente web em `http://127.0.0.1:5173` |
| `npm run check` | Valida sintaxe de todos os scripts e a estrutura dos HTML |
| `npm run rebuild:native` | Compila o addon de áudio para o Electron |
| `npm run pack` | Pacote descompactado em `dist/win-unpacked/` |
| `npm run dist` | Instalador para Windows em `dist/` |

---
