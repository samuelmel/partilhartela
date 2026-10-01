/**
 * StreamP2P Web - Motor WebRTC / PeerJS (sem dependencias nativas).
 *
 * O hospedeiro web usa getDisplayMedia. Nao ha como excluir o Discord do
 * audio do sistema no navegador: quem precisa isolar o Discord deve usar o
 * aplicativo Desktop (addon WASAPI) ou as configuracoes do sistema.
 */

'use strict';

function setupPeerJS(targetRoomId) {
  updateStatus('connecting', 'Conectando ao servidor P2P...');

  const Signaling = window.StreamP2P ? window.StreamP2P.Signaling : null;
  const hostPeerId = Signaling
    ? Signaling.buildHostPeerId(targetRoomId)
    : 'streamp2p-room-' + targetRoomId;
  roomHostPeerId = hostPeerId;
  const peerConfig = Signaling
    ? Signaling.PEER_CONFIG
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], debug: 1 };

  peer = new window.Peer(hostPeerId, peerConfig);

  peer.on('open', () => {
    isHost = true;
    configureHostUI();
    updateStatus('waiting', 'Sala Pronta (Aguardando Espectadores)');
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      console.log('Sala ja ocupada. Entrando como Espectador...');
      peer.destroy();
      setupAsViewer(targetRoomId, hostPeerId);
    } else {
      console.error('PeerJS Error:', err);
      updateStatus('error', 'Erro P2P: ' + err.type);
      showToast('Falha na sinalizacao: ' + err.type);
    }
  });

  peer.on('connection', (dataConn) => {
    activeDataConns.set(dataConn.peer, dataConn);
    updateViewerCount();

    dataConn.on('open', () => {
      dataConn.send({ type: 'room-state', isSharing });
      if (isSharing && localStream) {
        peer.call(dataConn.peer, localStream);
        setTimeout(() => applyDynamicWebRTCBitrate(qualityConfig.bitrateBps), 500);
      }
    });

    dataConn.on('close', () => {
      activeDataConns.delete(dataConn.peer);
      updateViewerCount();
    });
  });

  peer.on('call', (call) => {
    call.answer(isSharing && localStream ? localStream : undefined);
    call.on('stream', (incomingStream) => {
      relayPublishedStream(incomingStream, call.peer);
    });
    setTimeout(() => applyDynamicWebRTCBitrate(qualityConfig.bitrateBps), 500);
  });
}

function setupAsViewer(targetRoomId, hostPeerId) {
  isHost = false;
  roomHostPeerId = hostPeerId;

  const Signaling = window.StreamP2P ? window.StreamP2P.Signaling : null;
  const peerConfig = Signaling
    ? Signaling.PEER_CONFIG
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], debug: 1 };

  peer = new window.Peer(peerConfig);

  peer.on('open', () => {
    configureViewerUI();
    updateStatus('waiting', 'Conectando ao Transmissor...');

    const dataConn = peer.connect(hostPeerId, { reliable: true });

    dataConn.on('open', () => {
      updateStatus('online', 'Conectado ao Transmissor');
      showToast('Conectado a sala de transmissao com sucesso!');
    });

    dataConn.on('data', (data) => {
      if (data.type === 'stream-stopped') {
        showViewerWaitingState('O transmissor interrompeu o compartilhamento de tela.');
      } else if (data.type === 'room-state' && !data.isSharing) {
        showViewerWaitingState('O transmissor esta na sala, mas ainda nao iniciou o compartilhamento.');
      }
    });

    dataConn.on('close', () => {
      updateStatus('error', 'Transmissor Desconectado');
      showViewerWaitingState('A conexao com o transmissor foi perdida. Aguardando reconexao...');
    });
  });

  peer.on('call', (call) => {
    activeCall = call;
    call.answer();
    call.on('stream', (incomingStream) => attachRemoteStream(incomingStream, call.peer));
    call.on('close', () => showViewerWaitingState('Transmissao encerrada.'));
    call.on('error', (err) => {
      console.error('Erro na chamada WebRTC:', err);
      showToast('Erro no recebimento do video WebRTC.');
    });
  });

  peer.on('error', (err) => {
    console.error('Erro no receptor:', err);
    updateStatus('error', 'Erro: ' + err.type);
  });
}

/** Distribui a tela publicada por um participante aos demais participantes. */
function relayPublishedStream(stream, publisherPeerId) {
  if (!isSharing) attachRemoteStream(stream, publisherPeerId);
  activeDataConns.forEach((dataConn, participantPeerId) => {
    if (participantPeerId === publisherPeerId) return;
    try { peer.call(participantPeerId, stream); } catch (err) {
      console.error('Erro ao retransmitir stream publicada:', err);
    }
  });
}

/**
 * Captura no navegador.
 *
 * Sem `displaySurface: "monitor"`: essa constraint travava a UI do Chrome
 * quando combinada com limites rigidos de resolucao/fps.
 */
async function toggleScreenSharing() {
  if (isSharing) {
    stopScreenSharing();
    return;
  }

  const Utils = window.StreamP2P ? window.StreamP2P.Utils : null;
  const withTimeout = Utils
    ? Utils.withTimeout
    : (p, ms, label) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout: ' + label)), ms))
      ]);
  const stopAllTracks = Utils
    ? Utils.stopAllTracks
    : (s) => s && s.getTracks && s.getTracks().forEach((t) => t.stop());

  try {
    updateStatus('connecting', 'Aguardando selecao de tela...');

    try {
      localStream = await withTimeout(
        navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: qualityConfig.width, max: qualityConfig.width },
            height: { ideal: qualityConfig.height, max: qualityConfig.height },
            frameRate: { ideal: qualityConfig.fps, max: qualityConfig.fps }
          },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            suppressLocalAudioPlayback: false
          }
        }),
        15000,
        'captura de tela'
      );
    } catch (err) {
      console.warn('Constraints especificas rejeitadas, usando modo padrao:', err);
      try {
        localStream = await withTimeout(
          navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
          15000,
          'captura de tela (padrao)'
        );
      } catch (err2) {
        console.error('Falha completa na captura:', err2);
        updateStatus('waiting', 'Erro na Captura');
        showToast('Nao foi possivel capturar a tela. Verifique as permissoes do navegador.');
        return;
      }
    }

    isSharing = true;

    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        console.log('Compartilhamento interrompido via barra nativa do navegador.');
        stopScreenSharing();
      };
      applyContentHint(qualityConfig.contentHint);
    }

    attachLocalStream(localStream);
    elements.videoPlaceholder.classList.add('hidden');
    elements.liveOverlay.classList.remove('hidden');
    elements.liveOverlay.classList.add('flex');

    const settings = videoTrack ? videoTrack.getSettings() : {};
    const actualHeight = settings.height || qualityConfig.height;
    const actualFps = settings.frameRate || qualityConfig.fps;
    const modeLabel = window.StreamP2P
      ? window.StreamP2P.Quality.labelFor(currentMode)
      : currentMode;
    elements.qualityStats.textContent =
      modeLabel + ': ' + actualHeight + 'p @ ' + Math.round(actualFps) + 'FPS';

    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      setupAudioMeter(localStream);
      elements.audioStatusText.textContent = 'Audio Ativo';
      elements.audioStatusIcon.setAttribute('data-lucide', 'volume-2');
      elements.audioStatusBadge.classList.remove('hidden');
      showToast('Atencao: no navegador o audio e o do sistema e pode incluir o Discord. Para isolar, use o aplicativo Desktop.');
    } else {
      elements.audioStatusText.textContent = 'Sem Audio';
      elements.audioStatusIcon.setAttribute('data-lucide', 'volume-x');
      if (isFirefox) {
        showToast('Firefox: para transmitir som, escolha a opcao "Guia do Navegador".');
      }
    }

    elements.iconToggleShare.setAttribute('data-lucide', 'square');
    elements.textToggleShare.textContent = 'Interromper Transmissao';
    elements.btnToggleShare.classList.replace('bg-brand-600', 'bg-red-600');
    elements.btnToggleShare.classList.replace('hover:bg-brand-500', 'hover:bg-red-500');

    updateStatus('sharing', 'Transmitindo Ao Vivo');

    if (isHost) {
      activeDataConns.forEach((dataConn, viewerPeerId) => {
        peer.call(viewerPeerId, localStream);
      });
    } else if (roomHostPeerId) {
      activeCall = peer.call(roomHostPeerId, localStream);
    }

    setTimeout(() => {
      applyDynamicWebRTCBitrate(qualityConfig.bitrateBps);
      setTimeout(() => startAdaptiveBitrateMonitor(), 3000);
    }, 600);

    refreshIcons();
  } catch (err) {
    console.error('Erro ao iniciar transmissao:', err);
    isSharing = false;
    stopAllTracks(localStream);
    localStream = null;
    updateStatus('waiting', 'Erro na Captura');
    showToast('Falha ao iniciar captura: ' + err.message);
  }
}

function stopScreenSharing() {
  teardownAudioMeter();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  removeLocalStream();
  isSharing = false;

  activeDataConns.forEach((dataConn) => {
    try { dataConn.send({ type: 'stream-stopped' }); } catch (e) { /* ignora */ }
  });

  elements.iconToggleShare.setAttribute('data-lucide', 'screen-share');
  elements.textToggleShare.textContent = isHost
    ? 'Iniciar Compartilhamento'
    : 'Compartilhar Minha Tela';
  elements.btnToggleShare.classList.replace('bg-red-600', 'bg-brand-600');
  elements.btnToggleShare.classList.replace('hover:bg-red-500', 'hover:bg-brand-500');

  updateStatus('waiting', 'Sala Pronta (Aguardando)');
  stopAdaptiveBitrateMonitor();
  showToast('Transmissao de tela encerrada.');
  refreshIcons();
}

function toggleAudioTrack() {
  if (!isHost || !localStream) return;

  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) {
    showToast('Nenhum canal de audio capturado nesta sessao.');
    return;
  }

  isAudioMuted = !isAudioMuted;
  audioTracks[0].enabled = !isAudioMuted;

  if (isAudioMuted) {
    elements.iconToggleAudio.setAttribute('data-lucide', 'volume-x');
    elements.iconToggleAudio.className = 'w-4 h-4 text-red-400';
    elements.textToggleAudio.textContent = 'Audio Mudo';
    elements.audioStatusText.textContent = 'Audio Desativado';
    elements.audioStatusIcon.setAttribute('data-lucide', 'volume-x');
    showToast('Audio da transmissao silenciado.');
  } else {
    elements.iconToggleAudio.setAttribute('data-lucide', 'volume-2');
    elements.iconToggleAudio.className = 'w-4 h-4 text-emerald-400';
    elements.textToggleAudio.textContent = 'Audio Ativo';
    elements.audioStatusText.textContent = 'Audio Ativo';
    elements.audioStatusIcon.setAttribute('data-lucide', 'volume-2');
    showToast('Audio da transmissao reativado.');
  }
  refreshIcons();
}

function toggleViewerAudioMute() {
  if (isHost) return;
  elements.remoteVideo.muted = !elements.remoteVideo.muted;

  if (elements.remoteVideo.muted) {
    elements.iconToggleAudio.setAttribute('data-lucide', 'volume-x');
    elements.iconToggleAudio.className = 'w-4 h-4 text-red-400';
    elements.textToggleAudio.textContent = 'Audio Mudo';
    showToast('Audio da transmissao mutado localmente.');
  } else {
    elements.iconToggleAudio.setAttribute('data-lucide', 'volume-2');
    elements.iconToggleAudio.className = 'w-4 h-4 text-emerald-400';
    elements.textToggleAudio.textContent = 'Audio Ativo';
    showToast('Audio da transmissao ativado.');
  }
  refreshIcons();
}

function applyDynamicWebRTCBitrate(bitrateBps) {
  if (!peer) return;

  Object.values(peer.connections || {}).forEach((connectionList) => {
    (connectionList || []).forEach((conn) => {
      const pc = conn && conn.peerConnection;
      if (!pc) return;

      pc.getSenders().forEach((sender) => {
        if (!sender.track || sender.track.kind !== 'video') return;

        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        if (bitrateBps > 0) {
          params.encodings[0].maxBitrate = bitrateBps;
        } else {
          delete params.encodings[0].maxBitrate;
        }
        params.encodings[0].degradationPreference = 'maintain-framerate';
        sender.setParameters(params)
          .catch((err) => console.warn('Bitrate set err:', err));
      });
    });
  });
}

let _adaptiveMonitorInterval = null;

function startAdaptiveBitrateMonitor() {
  stopAdaptiveBitrateMonitor();
  let consecutiveBadReports = 0;
  let currentBitrate = qualityConfig.bitrateBps;

  _adaptiveMonitorInterval = setInterval(async () => {
    if (!peer || !isSharing) return;

    let lost = 0;
    let sent = 0;

    try {
      for (const connList of Object.values(peer.connections || {})) {
        for (const conn of connList || []) {
          const pc = conn && conn.peerConnection;
          if (!pc) continue;
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              sent += report.packetsSent || 0;
            }
            if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
              lost += report.packetsLost || 0;
            }
          });
        }
      }
    } catch (e) {
      return;
    }

    const lossRate = sent > 0 ? (lost / sent) : 0;

    if (lossRate > 0.05) {
      consecutiveBadReports++;
      if (consecutiveBadReports >= 2) {
        const reduced = Math.max(Math.floor(currentBitrate * 0.75), 600000);
        if (reduced < currentBitrate) {
          currentBitrate = reduced;
          applyDynamicWebRTCBitrate(currentBitrate);
        }
        consecutiveBadReports = 0;
      }
    } else if (lossRate < 0.01 && currentBitrate < qualityConfig.bitrateBps) {
      consecutiveBadReports = 0;
      const restored = Math.min(
        Math.floor(currentBitrate * 1.15), qualityConfig.bitrateBps);
      if (restored > currentBitrate) {
        currentBitrate = restored;
        applyDynamicWebRTCBitrate(currentBitrate);
      }
    }
  }, 4000);
}

function stopAdaptiveBitrateMonitor() {
  if (_adaptiveMonitorInterval) {
    clearInterval(_adaptiveMonitorInterval);
    _adaptiveMonitorInterval = null;
  }
}

function applyContentHint(hint) {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack && 'contentHint' in videoTrack) {
    videoTrack.contentHint = hint;
  }
}