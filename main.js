const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('path');

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

  // Carrega a interface da aplicação
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Manipulador IPC para listar telas e janelas ativas no Windows
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });

    return sources.map(source => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon ? source.appIcon.toDataURL() : null
    }));
  } catch (error) {
    console.error('Erro ao capturar fontes de tela:', error);
    return [];
  }
});

// Suporte nativo para getDisplayMedia no Chromium do Electron
app.whenReady().then(() => {
  // Configura manipulador de captura de display media caso getDisplayMedia padrão seja chamado
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      // Por padrão, se chamada getDisplayMedia sem seletor, seleciona a tela principal
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
