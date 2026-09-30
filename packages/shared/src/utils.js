/**
 * @streamp2p/shared - Utilitarios gerais (browser detection, PIDs, timeout).
 *
 * Modulo UMD: funciona como script no renderer e como require() no Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.StreamP2P = root.StreamP2P || {};
  root.StreamP2P.Utils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function detectBrowser(userAgent) {
    const ua = String(userAgent ||
      (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '').toLowerCase();
    return {
      isFirefox: ua.includes('firefox'),
      isChrome: ua.includes('chrome') && !ua.includes('edge'),
      isEdge: ua.includes('edg'),
      isSafari: ua.includes('safari') && !ua.includes('chrome')
    };
  }

  function isElectronRenderer() {
    return typeof window !== 'undefined' &&
      !!window.electronAPI && window.electronAPI.isElectron === true;
  }

  /**
   * Rejeita se a promise nao resolver em `ms`.
   * `onLateResolve` permite descartar recursos que chegaram tarde
   * (ex.: parar tracks de uma captura que deu timeout).
   */
  function withTimeout(promise, ms, label, onLateResolve) {
    let timedOut = false;
    let timerId = null;

    const guarded = promise.then(function (value) {
      if (timedOut && typeof onLateResolve === 'function') {
        try { onLateResolve(value); } catch (e) { /* ignora */ }
      }
      return value;
    });

    const guard = new Promise(function (_, reject) {
      timerId = setTimeout(function () {
        timedOut = true;
        reject(new Error('Timeout ao capturar: ' + (label || 'desconhecido')));
      }, ms);
    });

    return Promise.race([guarded, guard]).finally(function () {
      clearTimeout(timerId);
    });
  }

  /** Para todas as tracks de um MediaStream (aceita MediaStream ou array). */
  function stopAllTracks(stream) {
    if (!stream) return;
    if (typeof stream.getTracks === 'function') {
      stream.getTracks().forEach(function (t) {
        try { t.stop(); } catch (e) { /* ignora */ }
      });
    }
  }

  function fmtBitrate(bps) {
    if (!bps || bps <= 0) return 'Automático';
    return (bps / 1000000).toFixed(1).replace('.0', '') + ' Mbps';
  }

  return {
    detectBrowser,
    isElectronRenderer,
    withTimeout,
    stopAllTracks,
    fmtBitrate
  };
});