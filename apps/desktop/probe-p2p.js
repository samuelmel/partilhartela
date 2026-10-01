/**
 * Probe P2P: valida o transporte de audio do WebRTC entre dois pares.
 *
 * Objetivo: separar "a captura nao tem audio" de "o audio nao chega no
 * espectador". A Fase 1 ja provou que a captura tem sinal em qualquer fonte;
 * aqui medimos DEPOIS do RTCPeerConnection.
 *
 * Duas janelas na mesma instancia do Electron:
 *   - HOST    captura tela (audio+video juntos) e envia
 *   - VIEWER  recebe e mede o RMS da faixa de audio
 *
 * O SDP/ICE e trocado via IPC do processo main, sem depender do PeerServer
 * publico: isolar o transporte nao deve depender de um broker externo.
 *
 * Uso: npx electron probe-p2p.js
 */
'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const OUT = path.join(os.tmpdir(), 'streamp2p-p2p.json');
const RESULTS = [];

let hostWin = null;
let viewerWin = null;
let flushed = false;

function record(entry) {
  RESULTS.push(Object.assign({ at: Date.now() }, entry));
}

function flush(code) {
  if (flushed) return;
  flushed = true;
  try {
    fs.writeFileSync(OUT, JSON.stringify({
      exitCode: code,
      results: RESULTS
    }, null, 2), 'utf8');
  } catch (err) {
    console.log('falha ao escrever p2p probe:', err.message);
  }
  console.log('RESULTADO EM: ' + OUT);
  app.exit(code);
}

// ---- Relay de sinalizacao entre as duas janelas ---------------------------

ipcMain.on('p2p-report', (_e, entry) => {
  record(Object.assign({ via: 'report' }, entry));
});

ipcMain.on('p2p-signal', (_e, msg) => {
  record({ type: 'SIGNAL', dir: msg.from + '->' + msg.to, kind: msg.payload && msg.payload.type });
  const target = msg.to === 'viewer' ? viewerWin : hostWin;
  if (target && !target.isDestroyed()) {
    target.webContents.send('p2p-signal', msg);
  }
});

ipcMain.handle('p2p-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 }
  });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

// ---- Cycle de vida -------------------------------------------------------

app.whenReady().then(() => {
  // Sem handler, o getDisplayMedia abriria dialogo nativo. Nao usamos
  // getDisplayMedia aqui, mas o handler evita qualquer prompt inesperado.
  session.defaultSession.setDisplayMediaRequestHandler((_r, callback) => {
    callback({});
  });

  const webPreferences = {
    preload: path.join(__dirname, 'probe-p2p-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false
  };

  hostWin = new BrowserWindow({
    width: 640, height: 480, show: false,
    webPreferences
  });

  viewerWin = new BrowserWindow({
    width: 640, height: 480, show: false,
    webPreferences
  });

  hostWin.webContents.on('render-process-gone', (_e, details) => {
    record({ type: 'RENDERER_GONE', which: 'host', reason: details.reason, exitCode: details.exitCode });
    flush(2);
  });
  viewerWin.webContents.on('render-process-gone', (_e, details) => {
    record({ type: 'RENDERER_GONE', which: 'viewer', reason: details.reason, exitCode: details.exitCode });
    flush(2);
  });

  // tone=0 desliga o tom interno do probe. Necesario quando se testa com
  // audio EXTERNO: o Chromium pode excluir o audio da propria pagina no
  // caminho do WebRTC, o que mascara o resultado.
  const tone = process.env.P2P_TONE === '0' ? '0' : '1';

  hostWin.loadFile(path.join(__dirname, 'probe-p2p.html'), {
    query: { role: 'host', tone }
  });
  viewerWin.loadFile(path.join(__dirname, 'probe-p2p.html'), {
    query: { role: 'viewer', tone }
  });

  let loaded = 0;
  const onLoad = () => {
    loaded++;
    if (loaded < 2) return;
    // Janela de seguranca: as medicoes levam ~12s.
    setTimeout(() => {
      record({ type: 'TIMEOUT_END', note: 'janela de encerramento expirou' });
      flush(0);
    }, 45000);
  };

  hostWin.webContents.on('did-finish-load', onLoad);
  viewerWin.webContents.on('did-finish-load', onLoad);
});

app.on('window-all-closed', () => flush(0));