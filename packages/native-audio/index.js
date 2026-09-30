/**
 * @streamp2p/native-audio
 *
 * Loader do addon nativo com deteccao de disponibilidade.
 *
 * O addon e OPCIONAL: se nao estiver compilado, ou se o SO nao suportar
 * PROCESS_LOOPBACK_MODE_EXCLUDE (build < 20348), este modulo expoe
 * `available: false` e o app cai no comportamento anterior (audio do sistema
 * via Electron / navegador). Nao deve nunca lancar no require.
 */

'use strict';

const path = require('path');

let native = null;
let loadError = null;

const CANDIDATES = [
  path.join(__dirname, 'build', 'Release', 'streamp2p_audio.node'),
  path.join(__dirname, 'build', 'Debug', 'streamp2p_audio.node')
];

for (const candidate of CANDIDATES) {
  try {
    native = require(candidate);
    break;
  } catch (err) {
    loadError = err;
  }
}

/**
 * Verifica se o SO suporta exclusao de audio por processo.
 * Nao carrega o addon: e seguro rodar no renderer (sem native).
 */
function isOsSupported() {
  if (typeof process !== 'undefined' && process.platform !== 'win32') {
    return { supported: false, build: 0, requiredBuild: 20348 };
  }
  if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
    try {
      const os = process.getBuiltinModule('os');
      return {
        supported: os.release() !== undefined,
        build: parseBuild(os.release()),
        requiredBuild: 20348
      };
    } catch (e) {
      /* segue para o fallback */
    }
  }
  return { supported: true, build: 0, requiredBuild: 20348 };
}

function parseBuild(release) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(release || ''));
  return match ? Number(match[3]) : 0;
}

const osSupport = isOsSupported();

/**
 * Estado real: precisa do binario compilado E do SO compativel.
 */
function getStatus() {
  const loaded = native !== null;
  // Se nao der para determinar a build, deixa o addon decidir (ele reporta
  // E_NOTIMPL com precisao).
  const buildKnown = osSupport.build > 0;
  const supported = loaded && (!buildKnown || osSupport.build >= 20348);

  let reason = null;
  if (!loaded) {
    reason = 'Binario nativo nao encontrado. Rode: npm run build:native';
  } else if (!supported) {
    reason = `SO build ${osSupport.build} < 20348 nao suporta exclusao de audio por processo`;
  }

  return {
    loaded,
    supported,
    build: osSupport.build,
    requiredBuild: 20348,
    reason,
    error: loadError ? loadError.message : null
  };
}

/**
 * Inicia a captura de audio do sistema excluindo os PIDs informados.
 *
 * @param {number[]} excludedPids
 * @param {(sampleRate:number, channels:number, pcm:Int16Array)=>void} onAudioChunk
 * @param {(message:string)=>void} [onError]
 * @returns {{ok:boolean, error:?string, excludedCount:number, sampleRate:number, channels:number}}
 */
function startAudioCapture(excludedPids, onAudioChunk, onError) {
  const status = getStatus();

  if (!status.loaded) {
    return {
      ok: false,
      error: status.reason,
      excludedCount: 0,
      sampleRate: 0,
      channels: 0
    };
  }

  if (!status.supported) {
    return {
      ok: false,
      error: status.reason,
      excludedCount: 0,
      sampleRate: 0,
      channels: 0
    };
  }

  const config = {
    excludedPids: Array.isArray(excludedPids) ? excludedPids : [],
    onData: onAudioChunk,
    onError: onError || (() => {})
  };

  try {
    return native.startAudioCapture(config);
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      excludedCount: 0,
      sampleRate: 0,
      channels: 0
    };
  }
}

function stopAudioCapture() {
  if (!native) return false;
  try {
    return native.stopAudioCapture();
  } catch (err) {
    return false;
  }
}

function getAudioFormat() {
  if (!native) return { sampleRate: 48000, channels: 2, bitsPerSample: 16 };
  try {
    return native.getAudioFormat();
  } catch (err) {
    return { sampleRate: 48000, channels: 2, bitsPerSample: 16 };
  }
}

function getExcludedPids() {
  if (!native) return [];
  try {
    return native.getExcludedPids();
  } catch (err) {
    return [];
  }
}

module.exports = {
  available: native !== null,
  startAudioCapture,
  stopAudioCapture,
  getAudioFormat,
  getExcludedPids,
  getStatus,
  raw: native
};