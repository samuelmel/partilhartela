/**
 * StreamP2P Web - Config & Estado Global
 *
 * Sem dependencias nativas: nao ha Electron, addon C++ nem desktopCapturer.
 * A captura usa apenas getDisplayMedia.
 */

'use strict';

// URL publica usada para montar link de sala.
const WEB_APP_URL = '';

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

const isElectron = false;

const qualityConfig = window.StreamP2P
  ? window.StreamP2P.Quality.createQualityConfig()
  : {
      height: 1080, width: 1920, fps: 60,
      bitrateBps: 3500000, contentHint: 'motion'
    };

/**
 * No navegador nao ha como excluir processos do audio do sistema.
 * `mutedByDefault` faz o host silenciar a faixa de audio por padrao para
 * evitar expor audio do sistema sem consentimento explicito.
 */
const audioStrategy = {
  mode: 'browser',
  excludedPids: [],
  lastError: null,
  nativeAvailable: false
};