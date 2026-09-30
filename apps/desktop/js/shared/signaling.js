/**
 * @streamp2p/shared - Utilitarios de sinalizacao e sala.
 *
 * Modulo UMD: funciona como script no renderer e como require() no Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.StreamP2P = root.StreamP2P || {};
  root.StreamP2P.Signaling = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PEER_PREFIX = 'streamp2p-room-';

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ];

  const PEER_CONFIG = { iceServers: ICE_SERVERS, debug: 1 };

  /** Extrai o codigo da sala de uma URL ou de um codigo solto. */
  function parseRoomCode(input) {
    if (!input) return '';
    const raw = String(input).trim();
    if (!raw) return '';

    const match = /\?sala=([^&]+)/.exec(raw);
    if (match) {
      try {
        return decodeURIComponent(match[1]).trim();
      } catch (e) {
        return match[1].trim();
      }
    }

    // Codigo puro (sem URL e sem protocolo).
    if (!/[/?#]/.test(raw)) {
      return raw.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 64);
    }

    return '';
  }

  /** Gera um codigo de sala curto. */
  function generateRoomId() {
    if (typeof crypto !== 'undefined' &&
        crypto !== null && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    }
    return Math.random().toString(36).substring(2, 10);
  }

  function buildHostPeerId(roomId) {
    return PEER_PREFIX + roomId;
  }

  function buildShareUrl(baseUrl, roomId) {
    const clean = String(baseUrl || '').replace(/\/+$/, '');
    return clean + '/index.html?sala=' + encodeURIComponent(roomId);
  }

  return {
    PEER_PREFIX,
    ICE_SERVERS,
    PEER_CONFIG,
    parseRoomCode,
    generateRoomId,
    buildHostPeerId,
    buildShareUrl
  };
});