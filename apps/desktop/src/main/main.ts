import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, session } from 'electron';
import path from 'node:path';

const isDevelopment = !app.isPackaged;
let selectedCaptureSourceId: string | undefined;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  if (isDevelopment) {
    void window.loadURL('http://localhost:5173');
  } else {
    void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-video-encode');

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'display-capture';
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
      .then((sources) => {
        const source = sources.find((candidate) => candidate.id === selectedCaptureSourceId);
        if (!source) {
          callback({});
          return;
        }
        callback({ video: source });
      })
      .catch(() => callback({}));
  });

  ipcMain.handle('desktop:get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.toDataURL() ?? null
    }));
  });
  ipcMain.handle('desktop:set-capture-source', (_event, sourceId: unknown) => {
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new Error('Fonte de captura inválida.');
    }
    selectedCaptureSourceId = sourceId;
  });
  ipcMain.handle('desktop:copy-text', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Texto para copiar inválido.');
    }
    clipboard.writeText(text);
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
