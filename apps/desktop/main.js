/**
 * StreamP2P - App Desktop (Electron)
 *
 * Responsabilidades do processo main:
 *   - ciclo de vida da janela
 *   - listagem de fontes de captura (desktopCapturer)
 *   - deteccao de PIDs do Discord (para exclusao de audio no addon nativo)
 *   - ponte do modulo nativo @streamp2p/native-audio
 */

'use strict';

const {
  app, BrowserWindow, desktopCapturer, ipcMain, session, shell
} = require('electron');
const path = require('node:path');
const { exec } = require('node:child_process');

const { getDiscordPids, EXCLUDED_PROCESSES } =
  require('../../packages/shared/src/process-scan');

// ---------------------------------------------------------------------------
// Modulo nativo de audio (opcional)
// ---------------------------------------------------------------------------

let nativeAudio = null;
let nativeAudioError = null;

try {
  nativeAudio = require('../../packages/native-audio');
} catch (err) {
  nativeAudioError = err && err.message ? err.message : String(err);
}

function nativeAudioStatus() {
  if (nativeAudioError) {
    return {
      available: false,
      reason: 'Falha ao carregar o modulo nativo: ' + nativeAudioError
    };
  }
  if (!nativeAudio) {
    return { available: false, reason: 'Modulo nativo nao encontrado' };
  }
  const status = nativeAudio.getStatus();
  return {
    available: Boolean(status.supported),
    loaded: Boolean(status.loaded),
    build: status.build,
    requiredBuild: status.requiredBuild,
    reason: status.reason
  };
}

// ---------------------------------------------------------------------------
// Aceleracao de hardware
// ---------------------------------------------------------------------------

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch(
  'enable-hardware-overlays',
  'single-fullscreen,single-on-top,underlay'
);
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('force_high_performance_gpu');

// ---------------------------------------------------------------------------
// Janela
// ---------------------------------------------------------------------------

const isDev = !app.isPackaged;
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'StreamP2P Desktop',
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (isDev) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    stopNativeAudio();
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Captura de tela
// ---------------------------------------------------------------------------

ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 360, height: 200 },
      fetchWindowIcons: true
    });

    return sources.map((source) => {
      const lowerName = source.name.toLowerCase();
      const isDiscord = EXCLUDED_PROCESSES.some(
        (proc) => lowerName.includes(proc.toLowerCase())
      );
      const isScreen = source.id.startsWith('screen:');

      return {
        id: source.id,
        name: source.name,
        isScreen,
        // Janela do proprio StreamP2P nunca entra como candidata de audio.
        isSelf: lowerName.includes('streamp2p'),
        isExcluded: isDiscord,
        isDiscord,
        thumbnail: source.thumbnail.toDataURL(),
        appIcon: source.appIcon ? source.appIcon.toDataURL() : null
      };
    });
  } catch (error) {
    console.error('[main] Erro ao capturar fontes de tela:', error);
    return [];
  }
});

// ---------------------------------------------------------------------------
// PIDs do Discord
// ---------------------------------------------------------------------------

ipcMain.handle('get-excluded-pids', async () => {
  const result = await getDiscordPids();
  return {
    pids: result.pids,
    isRunning: result.isRunning,
    count: result.count,
    processes: EXCLUDED_PROCESSES
  };
});

// ---------------------------------------------------------------------------
// Audio nativo: ponte PCM (main) -> renderer
// ---------------------------------------------------------------------------

let nativeAudioRunning = false;
let nativeAudioFormat = { sampleRate: 48000, channels: 2 };

/**
 * O addon entrega o PCM no processo main via ThreadSafeFunction.
 * Aqui apenas reencaminha para o renderer, que monta a MediaStreamTrack.
 * ~192 KB/s em 48kHz/2ch: o custo de serializacao e irrelevante.
 */
function forwardAudioToRenderer(sampleRate, channels, pcmBuffer) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed()) return;

  contents.send('native-audio-data', {
    sampleRate,
    channels,
    pcm: pcmBuffer
  });
}

function notifyRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send(channel, payload);
}

function startNativeAudio(excludedPids) {
  if (!nativeAudio || !nativeAudio.available) {
    return {
      ok: false,
      error: (nativeAudioStatus().reason || 'Modulo nativo indisponivel')
    };
  }

  const result = nativeAudio.startAudioCapture(
    excludedPids || [],
    forwardAudioToRenderer,
    (message) => {
      console.error('[native-audio]', message);
      nativeAudioRunning = false;
      notifyRenderer('native-audio-error', message);
    }
  );

  nativeAudioRunning = Boolean(result && result.ok);
  if (nativeAudioRunning) {
    nativeAudioFormat = {
      sampleRate: result.sampleRate || 48000,
      channels: result.channels || 2
    };
  }
  return result;
}

function stopNativeAudio() {
  if (nativeAudio && nativeAudio.available) {
    nativeAudio.stopAudioCapture();
  }
  if (nativeAudioRunning) {
    nativeAudioRunning = false;
    notifyRenderer('native-audio-stopped', null);
  }
}

ipcMain.handle('native-audio-status', async () => {
  return {
    ...nativeAudioStatus(),
    running: nativeAudioRunning,
    format: nativeAudio && nativeAudio.available
      ? nativeAudio.getAudioFormat()
      : null
  };
});

ipcMain.handle('native-audio-start', async (_event, excludedPids) => {
  console.log('[main] native-audio-start pids=', excludedPids);
  const result = startNativeAudio(excludedPids);
  console.log('[main] native-audio-start ok=', result.ok, result.error || '');
  return result;
});

ipcMain.handle('native-audio-stop', async () => {
  stopNativeAudio();
  return { ok: true };
});

app.on('before-quit', () => {
  stopNativeAudio();
});

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  // Só anexa loopback do sistema se o renderer realmente pediu audio.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      callback({
        video: sources[0],
        audio: request.audioRequested ? 'loopback' : undefined
      });
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopNativeAudio();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});