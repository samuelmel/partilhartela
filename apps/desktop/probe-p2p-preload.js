/**
 * Probe P2P - preload: relay de sinalizacao e relatorio ao main.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('p2p', {
  role: null,
  getSources: () => ipcRenderer.invoke('p2p-sources'),
  signal: (from, to, payload) =>
    ipcRenderer.send('p2p-signal', { from, to, payload }),
  onSignal: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('p2p-signal', listener);
    return () => ipcRenderer.removeListener('p2p-signal', listener);
  },
  report: (entry) => ipcRenderer.send('p2p-report', entry)
});