const { contextBridge, ipcRenderer } = require('electron');

// Expõe APIs seguras para a camada de renderização (UI/HTML)
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources')
});
