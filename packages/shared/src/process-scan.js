/**
 * @streamp2p/shared - Deteccao de processos a excluir do audio.
 *
 * Usa `tasklist` nativo do Windows: zero dependencias extras (evita
 * `ps-list`, que traz uma arvore de modulos para algo que o SO ja resolve).
 *
 * Modulo UMD: funciona como script no renderer e como require() no Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.StreamP2P = root.StreamP2P || {};
  root.StreamP2P.ProcessScan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Processos sempre excluidos do audio transmitido. */
  const EXCLUDED_PROCESSES = ['Discord'];

  function runTasklist(names) {
    return new Promise(function (resolve) {
      if (typeof process === 'undefined' || process.platform !== 'win32') {
        resolve({ isRunning: false, pids: [], count: 0 });
        return;
      }

      const filters = names
        .map(function (name) { return 'IMAGENAME eq ' + name + '.exe'; })
        .join(' OR ');
      const command = 'tasklist /FI "' + filters +
        '" /FO CSV /NH';

      // Import dinamico para nao quebrar o carregamento no renderer.
      let childProcess;
      try {
        childProcess = require('node:child_process');
      } catch (err) {
        resolve({ isRunning: false, pids: [], count: 0 });
        return;
      }

      childProcess.exec(command, function (error, stdout) {
        if (error || !stdout) {
          resolve({ isRunning: false, pids: [], count: 0 });
          return;
        }

        const lines = String(stdout)
          .split(/\r?\n/)
          .filter(function (line) {
            return names.some(function (name) {
              return line.indexOf(name + '.exe') !== -1;
            });
          });

        if (lines.length === 0) {
          resolve({ isRunning: false, pids: [], count: 0 });
          return;
        }

        const pids = [];
        lines.forEach(function (line) {
          // Formato CSV: "ImageName","PID","Session Name",...
          const parts = line.replace(/"/g, '').split(',');
          const pid = parts[1] ? parseInt(parts[1].trim(), 10) : NaN;
          if (!isNaN(pid) && pids.indexOf(pid) === -1) {
            pids.push(pid);
          }
        });

        resolve({
          isRunning: pids.length > 0,
          pids: pids,
          count: pids.length
        });
      });
    });
  }

  function getDiscordPids() {
    return runTasklist(EXCLUDED_PROCESSES);
  }

  return {
    EXCLUDED_PROCESSES,
    getDiscordPids
  };
});