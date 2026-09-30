const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('path');
const { exec } = require('child_process');

// Aceleração por Hardware Dedicada (GPU / NVENC / AMD / Intel)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-hardware-overlays', 'single-fullscreen,single-on-top,underlay');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('force_high_performance_gpu');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "StreamP2P Desktop",
    backgroundColor: "#090d16",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Verifica e lista processos ativos do Discord no Windows
function checkDiscordProcess() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ isRunning: false, pids: [] });
    }

    exec('tasklist /FI "IMAGENAME eq Discord.exe" /FO CSV /NH', (error, stdout) => {
      if (error || !stdout) {
        return resolve({ isRunning: false, pids: [] });
      }

      const lines = stdout.trim().split('\n').filter(line => line.includes('Discord.exe'));
      if (lines.length === 0) {
        return resolve({ isRunning: false, pids: [] });
      }

      const pids = lines.map(line => {
        const parts = line.replace(/"/g, '').split(',');
        return parts[1] ? parseInt(parts[1].trim(), 10) : null;
      }).filter(pid => pid !== null && !isNaN(pid));

      resolve({
        isRunning: true,
        count: lines.length,
        pids: pids
      });
    });
  });
}

// IPC: Retorna status do Discord
ipcMain.handle('check-discord-status', async () => {
  return await checkDiscordProcess();
});

// IPC: Manipulador para listar telas e janelas ativas
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 360, height: 200 },
      fetchWindowIcons: true
    });

    return sources.map(source => {
      const isDiscordWindow = source.name.toLowerCase().includes('discord');
      const isScreen = source.id.startsWith('screen:');

      return {
        id: source.id,
        name: source.name,
        isScreen: isScreen,
        isDiscord: isDiscordWindow,
        thumbnail: source.thumbnail.toDataURL(),
        appIcon: source.appIcon ? source.appIcon.toDataURL() : null
      };
    });
  } catch (error) {
    console.error('Erro ao capturar fontes de tela:', error);
    return [];
  }
});

// Roteamento de áudio do sistema com isolamento no Electron
app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
