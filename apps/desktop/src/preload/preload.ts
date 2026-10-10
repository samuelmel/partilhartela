import { contextBridge, ipcRenderer } from 'electron';

export type DesktopSource = {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
};

contextBridge.exposeInMainWorld('partilharTela', {
  getSources: (): Promise<DesktopSource[]> => ipcRenderer.invoke('desktop:get-sources'),
  setCaptureSource: (sourceId: string): Promise<void> => ipcRenderer.invoke('desktop:set-capture-source', sourceId),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('desktop:copy-text', text)
});
