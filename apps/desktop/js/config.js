/**
 * StreamP2P Desktop - Config & Estado Global
 *
 * Modo ativo do transmissor: 'native' (addon C++ com exclusao por processo)
 * ou 'electron' (loopback / captura por janela).
 */

'use strict';

const WEB_APP_URL = 'https://streamp2p-zsv7.onrender.com';

const APP_VERSION = '1.0.0';

// Estado global do WebRTC
let peer = null;
let localStream = null;
let micStream = null;
let activeCall = null;
const activeDataConns = new Map();
let roomId = null;
let isHost = false;
let isSharing = false;
let isAudioMuted = false;
let isMicActive = false;
let currentMode = 'default';

// Estado do Web Audio
let audioContext = null;
let audioAnalyser = null;
let audioAnimFrame = null;
let _audioMeterSource = null;

// Ambiente
const browserInfo = window.StreamP2P
  ? window.StreamP2P.Utils.detectBrowser()
  : { isFirefox: false, isChrome: false, isEdge: false, isSafari: false };
const isFirefox = browserInfo.isFirefox;

const isElectron = Boolean(
  window.electronAPI && window.electronAPI.isElectron
);

// Quality config vem do pacote compartilhado.
const qualityConfig = window.StreamP2P
  ? window.StreamP2P.Quality.createQualityConfig()
  : {
      height: 1080, width: 1920, fps: 60,
      bitrateBps: 3500000, contentHint: 'motion'
    };

/** Estrategia de audio da transmissao. */
const audioStrategy = {
  /** 'native' = addon WASAPI com exclusao de processo */
  mode: 'native',
  /** PIDs efetivamente excluidos na captura atual */
  excludedPids: [],
  /** Ultimo erro conhecido do addon nativo */
  lastError: null,
  /** true se o addon foi compilado e o SO suporta */
  nativeAvailable: false
};