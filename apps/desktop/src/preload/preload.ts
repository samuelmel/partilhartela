import { contextBridge, ipcRenderer } from 'electron';

export type DesktopSource = {
  id: string;
  type: 'screen' | 'window';
  name: string;
  thumbnail: string;
  appIcon: string | null;
  processId?: string;
};

contextBridge.exposeInMainWorld('partilharTela', {
  getSources: (): Promise<DesktopSource[]> => ipcRenderer.invoke('desktop:get-sources'),
  getAudioProcesses: (): Promise<Array<{ title: string; processId: string }>> => ipcRenderer.invoke('audio:get-processes'),
  setCaptureSource: (sourceId: string): Promise<void> => ipcRenderer.invoke('desktop:set-capture-source', sourceId),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('desktop:copy-text', text),
  startApplicationAudio: (processId: string): Promise<void> => ipcRenderer.invoke('audio:start-application', processId),
  startSystemAudioExcluding: (processId: string): Promise<void> => ipcRenderer.invoke('audio:start-system-excluding', processId),
  stopApplicationAudio: (): Promise<void> => ipcRenderer.invoke('audio:stop-application'),
  consumePendingJoin: (): Promise<string | null> => ipcRenderer.invoke('desktop:consume-join'),
  onJoinRequest: (listener: () => void): (() => void) => {
    const callback = () => listener();
    ipcRenderer.on('deeplink:join', callback);
    return () => ipcRenderer.removeListener('deeplink:join', callback);
  },
  authorizeDiscord: (clientId: string): Promise<{ code: string; codeVerifier: string; redirectUri: string }> =>
    ipcRenderer.invoke('auth:discord-authorize', clientId),
  saveSession: (value: string): Promise<void> => ipcRenderer.invoke('auth:save-session', value),
  loadSession: (): Promise<string | null> => ipcRenderer.invoke('auth:load-session'),
  clearSession: (): Promise<void> => ipcRenderer.invoke('auth:clear-session'),
  onAudioData: (listener: (chunk: Uint8Array) => void): (() => void) => {
    const callback = (_event: Electron.IpcRendererEvent, chunk: Uint8Array) => listener(chunk);
    ipcRenderer.on('audio:data', callback);
    return () => ipcRenderer.removeListener('audio:data', callback);
  }
});
