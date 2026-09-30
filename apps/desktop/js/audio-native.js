/**
 * StreamP2P Desktop - Ponte de audio nativo.
 *
 * Converte os pacotes PCM (s16) vindos do processo main em uma
 * MediaStreamTrack consumivel pelo WebRTC.
 *
 * Estrategia: `MediaStreamTrackGenerator` + `AudioData`.
 * O AudioData carrega o proprio sampleRate, o que faz o navegador
 * reamostrar para a taxa do contexto de audio - dispensa resampler manual.
 *
 * Fallback: AudioContext + ScriptProcessorNode (para browsers sem generator).
 */

'use strict';

const NativeAudio = {
  track: null,
  generator: null,
  sampleRate: 48000,
  channels: 2,
  running: false,
  context: null,
  fallbackNode: null,
  lastError: null,
  _unsubscribers: []
};

/**
 * Detecta se o Chromium suporta MediaStreamTrackGenerator.
 */
function hasTrackGenerator() {
  return typeof window !== 'undefined' &&
    typeof window.MediaStreamTrackGenerator === 'function';
}

function hasAudioData() {
  return typeof window !== 'undefined' && typeof window.AudioData === 'function';
}

function supportsGenerator() {
  return hasTrackGenerator() && hasAudioData();
}

/**
 * Cria uma MediaStreamTrack de audio a partir da taxa/canais do mix format.
 */
function createTrack(sampleRate, channels) {
  NativeAudio.sampleRate = sampleRate || 48000;
  NativeAudio.channels = channels || 2;

  if (supportsGenerator()) {
    NativeAudio.generator = new window.MediaStreamTrackGenerator({
      kind: 'audio'
    });
    NativeAudio.track = NativeAudio.generator;
    return NativeAudio.track;
  }

  return createFallbackTrack(NativeAudio.sampleRate, NativeAudio.channels);
}

/**
 * Fallback sem MediaStreamTrackGenerator.
 *
 * O ScriptProcessorNode nao aceita entrada externa: ele so produz audio.
 * Entao os pacotes ficam numa fila e o no drena a fila a cada ciclo,
 * preenchendo com silencio quando ha underrun.
 */
function createFallbackTrack(sampleRate, channels) {
  const AudioContextCtor =
    window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('Web Audio API indisponivel para o audio nativo');
  }

  NativeAudio.context = new AudioContextCtor({ sampleRate: sampleRate });
  if (NativeAudio.context.state === 'suspended') {
    NativeAudio.context.resume().catch(() => {});
  }

  const destination = NativeAudio.context.createMediaStreamDestination();
  const frameCount = 2048;
  const processor = NativeAudio.context.createScriptProcessor(
    frameCount, channels, channels
  );

  // Fila de amostras float interleaved (buffer + cursor de leitura).
  NativeAudio.queueSize = frameCount * 8 * channels;
  NativeAudio.queue = new Float32Array(NativeAudio.queueSize);
  NativeAudio.queueLength = 0;

  processor.onaudioprocess = (event) => {
    const frames = frameCount;
    const needed = frames * channels;

    for (let ch = 0; ch < channels; ch++) {
      const out = event.outputBuffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        const available = NativeAudio.queueLength;
        if (available >= needed) {
          out[i] = NativeAudio.queue[i * channels + ch];
        } else {
          out[i] = 0;
        }
      }
    }

    // Consome um bloco inteiro da fila.
    if (NativeAudio.queueLength >= needed) {
      NativeAudio.queue.copyWithin(0, needed, NativeAudio.queueLength);
      NativeAudio.queueLength -= needed;
    } else {
      NativeAudio.queueLength = 0;
    }
  };

  processor.connect(destination);

  // ScriptProcessor so e chamado se estiver conectado a um destino "vivo".
  const keepAlive = NativeAudio.context.createConstantSource();
  keepAlive.connect(processor);
  keepAlive.start();

  NativeAudio.fallbackNode = processor;
  NativeAudio.fallbackKeepAlive = keepAlive;
  NativeAudio.track = destination.stream.getAudioTracks()[0];

  return NativeAudio.track;
}

/**
 * Escreve um pacote PCM s16 no destino.
 * @param {Int16Array} pcm  amostras interleaved
 * @param {number} channels  canais do pacote
 */
function writeChunk(pcm, channels) {
  if (!NativeAudio.running || !pcm || pcm.length === 0) return;

  if (NativeAudio.generator && typeof window.AudioData === 'function') {
    try {
      const audioData = new window.AudioData({
        format: 's16',
        sampleRate: NativeAudio.sampleRate,
        numberOfFrames: Math.floor(pcm.length / channels),
        numberOfChannels: channels,
        timestamp: 0,
        data: pcm
      });
      NativeAudio.generator.write(audioData);
      return;
    } catch (err) {
      NativeAudio.lastError = err;
      console.error('[audio-native] Falha ao escrever AudioData:', err);
    }
  }

  if (NativeAudio.queue && NativeAudio.queue.length) {
    const frames = Math.floor(pcm.length / channels);
    let written = 0;

    for (let i = 0; i < frames; i++) {
      if (NativeAudio.queueLength >= NativeAudio.queueSize) break;
      for (let ch = 0; ch < channels; ch++) {
        NativeAudio.queue[NativeAudio.queueLength++] =
          pcm[i * channels + ch] / 32768;
      }
      written++;
    }

    if (written === 0) {
      NativeAudio.queueLength = 0;
    }
  }
}

/**
 * Inicia o audio nativo do sistema com exclusao dos PIDs informados.
 * @returns {Promise<{ok:boolean, error:?string, track:?MediaStreamTrack}>}
 */
async function start(options) {
  const opts = options || {};

  await stop();

  if (!window.electronAPI || !window.electronAPI.isElectron) {
    return { ok: false, error: 'Audio nativo disponivel apenas no Desktop' };
  }

  let status;
  try {
    status = await window.electronAPI.getNativeAudioStatus();
  } catch (err) {
    return { ok: false, error: 'Falha ao consultar o modulo nativo: ' + err.message };
  }

  if (!status.available) {
    NativeAudio.lastError = status.reason || 'Modulo nativo indisponivel';
    return { ok: false, error: NativeAudio.lastError, status };
  }

  // Sem o addon pronto, nao ha o que iniciar.
  const result = await window.electronAPI.startNativeAudio(opts.excludedPids || []);
  if (!result || !result.ok) {
    NativeAudio.lastError = (result && result.error) || 'Falha ao iniciar captura';
    return { ok: false, error: NativeAudio.lastError, status };
  }

  const sampleRate = result.sampleRate || (status.format && status.format.sampleRate) || 48000;
  const channels = result.channels || (status.format && status.format.channels) || 2;

  try {
    const track = createTrack(sampleRate, channels);
    if (!track) {
      throw new Error('Nao foi possivel criar a MediaStreamTrack de audio');
    }
  } catch (err) {
    await window.electronAPI.stopNativeAudio();
    NativeAudio.lastError = err.message;
    return { ok: false, error: err.message, status };
  }

  // Assina os pacotes antes de marcar como rodando.
  NativeAudio._unsubscribers.push(
    window.electronAPI.onNativeAudioData((payload) => {
      if (!payload || !payload.pcm) return;
      try {
        writeChunk(new Int16Array(payload.pcm), payload.channels || NativeAudio.channels);
      } catch (err) {
        console.error('[audio-native] Erro no pacote de audio:', err);
      }
    })
  );

  NativeAudio._unsubscribers.push(
    window.electronAPI.onNativeAudioError((message) => {
      NativeAudio.lastError = message;
      console.error('[audio-native]', message);
    })
  );

  NativeAudio._unsubscribers.push(
    window.electronAPI.onNativeAudioStopped(() => {
      NativeAudio.running = false;
    })
  );

  NativeAudio.running = true;

  return {
    ok: true,
    error: null,
    track: NativeAudio.track,
    sampleRate: NativeAudio.sampleRate,
    channels: NativeAudio.channels,
    usingGenerator: supportsGenerator(),
    status
  };
}

/** Para a captura e libera os recursos do renderer. */
async function stop() {
  NativeAudio._unsubscribers.forEach((fn) => {
    try { fn(); } catch (e) { /* ignora */ }
  });
  NativeAudio._unsubscribers = [];
  NativeAudio.running = false;

  if (NativeAudio.generator) {
    try { NativeAudio.generator.close(); } catch (e) { /* ignora */ }
    NativeAudio.generator = null;
  }

  if (NativeAudio.fallbackNode) {
    try {
      NativeAudio.fallbackNode.onaudioprocess = null;
      NativeAudio.fallbackNode.disconnect();
    } catch (e) { /* ignora */ }
    NativeAudio.fallbackNode = null;
  }

  if (NativeAudio.fallbackKeepAlive) {
    try { NativeAudio.fallbackKeepAlive.stop(); } catch (e) { /* ignora */ }
    try { NativeAudio.fallbackKeepAlive.disconnect(); } catch (e) { /* ignora */ }
    NativeAudio.fallbackKeepAlive = null;
  }

  if (NativeAudio.context) {
    try { await NativeAudio.context.close(); } catch (e) { /* ignora */ }
    NativeAudio.context = null;
  }

  if (NativeAudio.track) {
    try { NativeAudio.track.stop(); } catch (e) { /* ignora */ }
    NativeAudio.track = null;
  }
}

function isRunning() {
  return NativeAudio.running;
}

function getTrack() {
  return NativeAudio.track;
}

function getLastError() {
  return NativeAudio.lastError;
}

function capabilities() {
  return {
    generator: supportsGenerator(),
    audioData: hasAudioData(),
    electron: Boolean(window.electronAPI && window.electronAPI.isElectron)
  };
}

// API consumida por webrtc.js (renderer sem sistema de modulos).
window.NativeAudioBridge = {
  start,
  stop,
  isRunning,
  getTrack,
  getLastError,
  capabilities
};