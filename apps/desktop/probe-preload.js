/**
 * Probe - preload: lista fontes e reporta resultados para o main.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('probeAPI', {
  getSources: () => ipcRenderer.invoke('probe-sources'),
  setTarget: (id) => ipcRenderer.invoke('probe-set-target', id),
  report: (entry) => ipcRenderer.send('probe-report', entry)
});