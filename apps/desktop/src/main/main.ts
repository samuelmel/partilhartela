import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, session, type MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import loopback, { type LoopbackCapture } from 'loopback-capture';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { authorizeWithDiscord, clearSession, handleProtocolAuth, loadSession, saveSession } from './discordAuth';

const isDevelopment = !app.isPackaged;
const devServerUrl = 'http://localhost:5173';
let selectedCaptureSourceId: string | undefined;
let audioCapture: LoopbackCapture | undefined;
let mainWindow: BrowserWindow | undefined;
// Código recebido por partilhartela://join/CODIGO antes de o renderer pedir (app abrindo pelo link).
let pendingJoinCode: string | undefined;
const protocolScheme = 'partilhartela';

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#232429',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  mainWindow = window;

  window.webContents.on('enter-html-full-screen', () => {
    window.setFullScreen(true);
  });
  window.webContents.on('leave-html-full-screen', () => {
    window.setFullScreen(false);
  });

  // Impede que o renderer (com a bridge do preload) navegue para conteúdo externo ou abra janelas.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDevelopment ? url.startsWith(devServerUrl) : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  if (isDevelopment) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools();
  } else {
    void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

function configureAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => {
    console.error('[PartilharTela] Falha ao verificar atualização:', error);
  });
  autoUpdater.on('update-downloaded', () => {
    const message: MessageBoxOptions = {
      type: 'info',
      title: 'Atualização pronta',
      message: 'Uma nova versão do PartilharTela foi baixada.',
      detail: 'Reinicie o aplicativo agora para aplicar a atualização.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1
    };
    const result = mainWindow
      ? dialog.showMessageBox(mainWindow, message)
      : dialog.showMessageBox(message);
    void result.then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  void autoUpdater.checkForUpdatesAndNotify();
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** partilhartela://join/CODIGO entra na sala; partilhartela://auth/callback conclui o login. */
function handleDeepLink(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== `${protocolScheme}:`) return;
  // Em URLs não especiais o "host" é o primeiro segmento: join, auth.
  const parts = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
  if (parts[0] === 'auth' && parts[1] === 'callback') {
    handleProtocolAuth(url);
    focusMainWindow();
    return;
  }
  const code = parts[0] === 'join' ? parts[1]?.toUpperCase() : undefined;
  if (!code || !/^[A-Z0-9]{6}$/.test(code)) return;
  // Guarda e só avisa: o renderer busca com consume-join (também ao montar), sem corrida nem entrada dupla.
  pendingJoinCode = code;
  focusMainWindow();
  mainWindow?.webContents.send('deeplink:join');
}

function findDeepLink(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${protocolScheme}://`));
}

// Uma instância só: abrir um link com o app aberto chega como 'second-instance' (Windows/Linux).
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = findDeepLink(argv);
    if (link) handleDeepLink(link);
    else focusMainWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  // Em desenvolvimento o executável é o electron.exe: registra com o caminho do app.
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(protocolScheme, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(protocolScheme);
  }
  const initialLink = findDeepLink(process.argv);
  if (initialLink) handleDeepLink(initialLink);
}

app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-video-encode');

// 'fullscreen' precisa estar aqui: sem ela o Electron rejeita element.requestFullscreen()
// e o botão de tela cheia do palco não fazia nada.
const allowedPermissions = new Set(['media', 'display-capture', 'fullscreen']);

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return allowedPermissions.has(permission);
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

    // Deduplicate by source.id to prevent duplicate entries
    const uniqueSources = Array.from(
      new Map(sources.map(source => [source.id, source])).values()
    );

    return uniqueSources.map((source) => ({
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
  ipcMain.handle('desktop:consume-join', () => {
    const code = pendingJoinCode;
    pendingJoinCode = undefined;
    return code ?? null;
  });
  ipcMain.handle('auth:discord-authorize', (_event, clientId: unknown) => authorizeWithDiscord(clientId));
  ipcMain.handle('auth:save-session', (_event, value: unknown) => saveSession(value));
  ipcMain.handle('auth:load-session', () => loadSession());
  ipcMain.handle('auth:clear-session', () => clearSession());

  createWindow();
  configureAutoUpdater();
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
      // UTF-8 explícito: sem isso títulos com acento/emoji chegam como '?'.
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object MainWindowTitle,Id | ConvertTo-Json -Compress'
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
