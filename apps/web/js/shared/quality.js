/**
 * @streamp2p/shared - Configuracao de qualidade.
 *
 * Modulo UMD: funciona como script no renderer (sem bundler) e como
 * require() no Node. Anexa em `globalThis.StreamP2P`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.StreamP2P = root.StreamP2P || {};
  root.StreamP2P.Quality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PRESETS = {
    default: {
      height: 1080, width: 1920, fps: 60,
      bitrateBps: 3500000, contentHint: 'motion',
      title: 'Padrão (1080p60)'
    },
    jogo: {
      height: 1080, width: 1920, fps: 60,
      bitrateBps: 5000000, contentHint: 'motion',
      title: 'Modo Jogo (60FPS / 5M)'
    },
    filme: {
      height: 1080, width: 1920, fps: 30,
      bitrateBps: 4000000, contentHint: 'detail',
      title: 'Modo Filme (30FPS / 4M)'
    }
  };

  const DEFAULT_QUALITY = {
    height: 1080,
    width: 1920,
    fps: 60,
    bitrateBps: 3500000,
    contentHint: 'motion'
  };

  const RESOLUTION_MAP = {
    2160: 3840,
    1080: 1920,
    720: 1280,
    480: 854
  };

  function createQualityConfig() {
    return Object.assign({}, DEFAULT_QUALITY);
  }

  /**
   * Normaliza os valores vindos do <select> do modal.
   * bitrate 0 = sem limite (delega ao controle de congestao do navegador).
   */
  function fromModalValues(resolution, fps, bitrate, contentHint) {
    const h = parseInt(resolution, 10) || 1080;
    return {
      height: h,
      width: RESOLUTION_MAP[h] || 1920,
      fps: parseInt(fps, 10) || 60,
      bitrateBps: parseInt(bitrate, 10) || 0,
      contentHint: contentHint === 'detail' ? 'detail' : 'motion'
    };
  }

  function labelFor(mode) {
    if (mode === 'jogo') return PRESETS.jogo.title;
    if (mode === 'filme') return PRESETS.filme.title;
    if (mode === 'custom') return 'Personalizado';
    return PRESETS.default.title;
  }

  function describe(config, mode) {
    return labelFor(mode) + ': ' + config.height + 'p @ ' + config.fps + 'FPS';
  }

  return {
    PRESETS,
    DEFAULT_QUALITY,
    RESOLUTION_MAP,
    createQualityConfig,
    fromModalValues,
    labelFor,
    describe
  };
});