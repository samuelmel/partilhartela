import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, session } from 'electron';
import loopback, { type LoopbackCapture } from 'loopback-capture';
import { execFile } from 'node:child_process';
import path from 'node:path';

const isDevelopment = !app.isPackaged;
let selectedCaptureSourceId: string | undefined;
let audioCapture: LoopbackCapture | undefined;
let mainWindow: BrowserWindow | undefined;

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
  mainWindow = window;

  if (isDevelopment) {
    void window.loadURL('http://localhost:5173');
  } else {
    void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
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
        callback({ video: source, audio: 'loopback' });
      })
      .catch(() => callback({}));
  });

  ipcMain.handle('desktop:get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    const windows = process.platform === 'win32' ? await findApplicationWindows() : [];
    return sources.map((source) => ({
      id: source.id,
      type: source.id.startsWith('screen:') ? 'screen' as const : 'window' as const,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.toDataURL() ?? null,
      processId: windows.find((window) => window.title === source.name || window.title.includes(source.name) || source.name.includes(window.title))?.processId
    }));
  });
  ipcMain.handle('audio:get-processes', async () => {
    if (process.platform !== 'win32') return [];
    return findApplicationWindows();
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
  ipcMain.handle('audio:start-application', (_event, processId: unknown) => {
    if (process.platform !== 'win32') throw new Error('Áudio por aplicativo só está disponível no Windows.');
    const pid = Number(processId);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Processo de áudio inválido.');
    audioCapture?.stop();
    audioCapture = new loopback.LoopbackCapture();
    audioCapture.start(pid, true, (chunk: Buffer) => mainWindow?.webContents.send('audio:data', new Uint8Array(chunk)));
  });
  ipcMain.handle('audio:start-system-excluding', async (_event, processId: unknown) => {
    if (process.platform !== 'win32') throw new Error('Áudio por exclusão só está disponível no Windows.');
    const pid = Number(processId);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Processo para excluir inválido.');
    audioCapture?.stop();
    audioCapture = new loopback.LoopbackCapture();
    audioCapture.start(pid, false, (chunk: Buffer) => mainWindow?.webContents.send('audio:data', new Uint8Array(chunk)));
  });
  ipcMain.handle('audio:stop-application', () => {
    audioCapture?.stop();
    audioCapture = undefined;
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  audioCapture?.stop();
  if (process.platform !== 'darwin') app.quit();
});

async function findApplicationWindows(): Promise<Array<{ title: string; processId: string }>> {
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object MainWindowTitle,Id | ConvertTo-Json -Compress'
    ], { windowsHide: true }, (_error, stdout) => {
      try {
        const parsed: unknown = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(rows.flatMap((row) => {
          if (!row || typeof row !== 'object') return [];
          const value = row as { MainWindowTitle?: unknown; Id?: unknown };
          return typeof value.MainWindowTitle === 'string' && typeof value.Id === 'number'
            ? [{ title: value.MainWindowTitle, processId: String(value.Id) }]
            : [];
        }));
      } catch {
        resolve([]);
      }
    });
  });
}
