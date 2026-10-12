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
apps/desktop/release/PartilharTela Setup 1.0.0.exe
```

### Onde hospedar para as pessoas baixarem:
1. **GitHub Releases (Recomendado)**: Crie uma nova Release na página do seu repositório no GitHub (`v1.0.0`) e faça o upload do arquivo `.exe`.
2. **Google Drive / OneDrive / Dropbox**: Suba o `.exe` e compartilhe o link de download direto com seus usuários.
3. **Página Web**: Hospede o `apps/web` (na Vercel, Netlify ou Render) e adicione um botão "Baixar para Windows" apontando para o arquivo `.exe`.

---

## 💻 Desenvolvimento Local

### Pré-requisitos
- **Windows 10/11**
- **Node.js 20+** e **npm 10+**

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

## 📁 Estrutura do Projeto

```text
COMPARTILHARTELAV2/
├── apps/
│   ├── desktop/            # Aplicação Desktop Electron + React
│   │   ├── src/main/       # Processo principal Electron e captura de áudio (loopback)
│   │   ├── src/preload/    # Bridge IPC segura com contextIsolation
│   │   ├── src/renderer/   # Interface React, conexão LiveKit e controles de transmissão
│   │   └── release/        # Pasta onde o instalador .exe é gerado
│   ├── server/             # API Fastify para autenticação e geração de tokens LiveKit
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

---

## 📄 Licença

Este projeto é privado e de uso livre para compartilhamento de tela pessoal e colaborativo.