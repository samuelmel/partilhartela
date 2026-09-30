/**
 * StreamP2P Desktop - Preload (contextBridge)
 *
 * Expoe uma API minima e explicita. Nao expoe `ipcRenderer` cru: cada canal
 * e uma funcao nomeada, o que mantem a superficie de ataque pequena.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // Captura de tela
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),

  // PIDs dos processos a excluir do audio (Discord)
  getExcludedPids: () => ipcRenderer.invoke('get-excluded-pids'),

  // Audio nativo (WASAPI process loopback com exclusao)
  getNativeAudioStatus: () => ipcRenderer.invoke('native-audio-status'),
  startNativeAudio: (excludedPids) =>
    ipcRenderer.invoke('native-audio-start', excludedPids),
  stopNativeAudio: () => ipcRenderer.invoke('native-audio-stop'),

  // Eventos emitidos pelo processo main
  onNativeAudioData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('native-audio-data', listener);
    return () => ipcRenderer.removeListener('native-audio-data', listener);
  },
  onNativeAudioError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('native-audio-error', listener);
    return () => ipcRenderer.removeListener('native-audio-error', listener);
  },
  onNativeAudioStopped: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('native-audio-stopped', listener);
    return () => ipcRenderer.removeListener('native-audio-stopped', listener);
  }
});