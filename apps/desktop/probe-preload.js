/**
 * Probe - preload: lista fontes e reporta resultados para o main.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('probeAPI', {
  getSources: () => ipcRenderer.invoke('probe-sources'),
  report: (entry) => ipcRenderer.send('probe-report', entry)
});