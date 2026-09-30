/**
 * Probe: isola qual chamada de captura mata o renderer.
 *
 * Escreve os resultados num arquivo para nao depender do stdout do Electron
 * (que nao e capturado em Windows GUI) nem da assinatura de console-message.
 *
 * Uso: npx electron probe.js
 */
'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const OUT = path.join(os.tmpdir(), 'streamp2p-probe.json');
const RESULTS = [];

let currentTest = '(nenhum)';
let requestedSourceId = null;
let win = null;

ipcMain.handle('probe-set-target', (_e, id) => {
  requestedSourceId = id;
  return true;
});

function flush(exitCode) {
  try {
    fs.writeFileSync(
      OUT,
      JSON.stringify({ exitCode, currentTest, results: RESULTS }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.log('falha ao escrever probe:', err.message);
  }
  console.log('RESULTADO EM: ' + OUT);
  app.exit(exitCode);
}

function record(entry) {
  RESULTS.push(entry);
  console.log(JSON.stringify(entry));
}

ipcMain.on('probe-report', (_e, entry) => {
  record(entry);
  if (entry.type === 'DONE') {
    // Todos os testes passaram: o renderer sobreviveu.
    flush(0);
  }
});

ipcMain.handle('probe-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 }
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    isScreen: s.id.startsWith('screen:')
  }));
});

app.whenReady().then(() => {
  // Handler de display media: e ele que impede o dialogo nativo e define
  // o que 'loopback' significa. Sem ele, getDisplayMedia abriria um prompt.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const picked = requestedSourceId
        ? sources.find((s) => s.id === requestedSourceId)
        : null;
      const source = picked || sources[0];
      console.log('HANDLER -> audioRequested=' + request.audioRequested +
        ' video=' + (source ? source.name : 'nenhuma'));
      callback({
        video: source,
        audio: request.audioRequested ? 'loopback' : undefined
      });
    });
  });

  win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'probe-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    record({
      type: 'RENDERER_GONE',
      test: currentTest,
      reason: details.reason,
      exitCode: details.exitCode
    });
    flush(2);
  });

  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      record({ type: 'TIMEOUT', test: currentTest });
      flush(3);
    }, 45000);
  });

  win.loadFile(path.join(__dirname, 'probe.html'));
});

app.on('window-all-closed', () => {
  flush(0);
});