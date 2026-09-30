/**
 * StreamP2P Desktop - Motor WebRTC / PeerJS.
 *
 * Fluxo de audio na Tela Cheia:
 *   1. video da tela via desktopCapturer/getUserMedia (sem audio)
 *   2. audio do sistema via addon nativo WASAPI, com PROCESS_LOOPBACK_MODE_EXCLUDE
 *      -> entrega TUDO que toca no PC, exceto os PIDs do Discord
 *   3. as duas tracks entram na MediaStream enviada aos espectadores
 *   4. se o addon nao estiver disponivel, cai no loopback do Electron
 */

'use strict';

// ---------------------------------------------------------------------------
// Sinalizacao
// ---------------------------------------------------------------------------

function setupPeerJS(targetRoomId) {
  updateStatus('connecting', 'Conectando ao servidor P2P...');

  const Signaling = window.StreamP2P ? window.StreamP2P.Signaling : null;
  const hostPeerId = Signaling
    ? Signaling.buildHostPeerId(targetRoomId)
    : 'streamp2p-room-' + targetRoomId;

  const peerConfig = Signaling
    ? Signaling.PEER_CONFIG
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], debug: 1 };

  peer = new window.Peer(hostPeerId, peerConfig);

  peer.on('open', () => {
    isHost = true;
    configureHostUI();
    probeNativeAudio();
    updateStatus('waiting', 'Sala Pronta (Aguardando Espectadores)');
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      console.log('ID do Host ja ocupado. Entrando como Espectador...');
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
    if (isSharing && localStream) {
      call.answer(localStream);
      setTimeout(() => applyDynamicWebRTCBitrate(qualityConfig.bitrateBps), 500);
    }
  });
}

function setupAsViewer(targetRoomId, hostPeerId) {
  isHost = false;

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
    call.on('stream', (incomingStream) => attachRemoteStream(incomingStream));
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

// ---------------------------------------------------------------------------
// Audio nativo
// ---------------------------------------------------------------------------

/**
 * Verifica se o addon nativo esta pronto e atualiza o badge da UI.
 * Roda no 'open' do Peer para o usuario ver o estado antes de transmitir.
 */
async function probeNativeAudio() {
  if (!isElectron) {
    audioStrategy.nativeAvailable = false;
    updateAudioFilterBadge([], false, null);
    return false;
  }

  try {
    const status = await window.electronAPI.getNativeAudioStatus();
    audioStrategy.nativeAvailable = Boolean(status.available);

    if (!status.available && status.reason) {
      audioStrategy.lastError = status.reason;
      console.warn('[audio] addon nativo indisponivel:', status.reason);
    }

    updateAudioFilterBadge([], audioStrategy.nativeAvailable, status.reason);
    return audioStrategy.nativeAvailable;
  } catch (err) {
    audioStrategy.nativeAvailable = false;
    audioStrategy.lastError = err.message;
    return false;
  }
}

/**
 * Monta a track de audio da transmissao.
 *
 * Prioridade:
 *   1. addon nativo (audio do sistema SEM os PIDs excluidos)
 *   2. loopback do sistema (inclui o Discord - apenas como fallback)
 *
 * @returns {Promise<{track:?MediaStreamTrack, mode:string, error:?string}>}
 */
async function buildAudioTrack(audioMode) {
  const Utils = window.StreamP2P ? window.StreamP2P.Utils : null;
  const stopAllTracks = Utils
    ? Utils.stopAllTracks
    : (s) => s && s.getTracks && s.getTracks().forEach((t) => t.stop());

  // Estrategia 1: addon nativo (audio do sistema SEM os PIDs excluidos).
  const wantsNative = audioMode !== 'system' && isElectron;

  if (wantsNative) {
    try {
      const pidInfo = await window.electronAPI.getExcludedPids();
      const pids = pidInfo && Array.isArray(pidInfo.pids) ? pidInfo.pids : [];
      audioStrategy.excludedPids = pids;

      if (elements.discordStatusDot) {
        if (pidInfo && pidInfo.isRunning) {
          elements.discordStatusDot.className =
            'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
          elements.discordStatusMsg.textContent =
            'Discord detectado (' + pidInfo.count + ' processo(s)) - audio sera EXCLUIDO';
        } else {
          elements.discordStatusDot.className =
            'w-2.5 h-2.5 rounded-full bg-gray-500';
          elements.discordStatusMsg.textContent = 'Discord nao esta aberto no momento';
        }
      }

      const result = await window.NativeAudioBridge.start({ excludedPids: pids });

      if (result.ok) {
        updateAudioFilterBadge(pids, true, null);
        return {
          track: result.track,
          mode: 'native',
          error: null,
          excludedPids: pids
        };
      }

      audioStrategy.lastError = result.error;
      console.warn('[audio] addon nativo indisponivel:', result.error);
      updateAudioFilterBadge([], false, result.error);
    } catch (err) {
      audioStrategy.lastError = err.message;
      console.warn('[audio] falha ao iniciar addon nativo:', err);
      updateAudioFilterBadge([], false, err.message);
    }
  }

  // Estrategia 2 (fallback): loopback do endpoint de saida padrao.
  // Este e o caminho historico do app: captura o audio do sistema pelo
  // dispositivo de saida. Em testes anteriores nao capturava o Discord.
  try {
    const audioOnly = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: false
    });

    const track = audioOnly.getAudioTracks()[0];
    if (track) {
      return { track: track, mode: 'loopback', error: null };
    }
    stopAllTracks(audioOnly);
  } catch (err) {
    console.warn('[audio] loopback do sistema falhou:', err);
    audioStrategy.lastError = err.message;
  }

  return { track: null, mode: 'none', error: audioStrategy.lastError };
}

/**
 * Substitui a track de audio em todos os senders ja negociados.
 *
 * Usado quando o Discord abre/fecha durante a transmissao: o espectador
 * passa a receber o audio filtrado sem precisar reconectar.
 */
async function replaceAudioTrackOnSenders(newTrack) {
  if (!peer || !newTrack) return 0;

  let replaced = 0;

  Object.values(peer.connections || {}).forEach((connectionList) => {
    (connectionList || []).forEach((conn) => {
      const pc = conn && conn.peerConnection;
      if (!pc) return;

      pc.getSenders().forEach((sender) => {
        const isAudio = sender.track
          ? sender.track.kind === 'audio'
          : (sender._initialKind === 'audio');
        if (!isAudio) return;

        sender.replaceTrack(newTrack).then(() => {
          replaced++;
        }).catch((err) => {
          console.warn('Falha no replaceTrack de audio:', err);
        });
      });
    });
  });

  return replaced;
}

// ---------------------------------------------------------------------------
// Captura de tela
// ---------------------------------------------------------------------------

async function toggleScreenSharing() {
  if (isSharing) {
    stopScreenSharing();
    return;
  }

  const Utils = window.StreamP2P ? window.StreamP2P.Utils : null;
  const withTimeout = Utils
    ? Utils.withTimeout
    : (p, ms, label, onLate) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout: ' + label)), ms))
      ]);
  const stopAllTracks = Utils
    ? Utils.stopAllTracks
    : (s) => s && s.getTracks && s.getTracks().forEach((t) => t.stop());

  try {
    updateStatus('connecting', 'Aguardando selecao de tela...');

    localStream = await captureElectronScreen({
      withTimeout,
      stopAllTracks
    });

    if (!localStream) {
      updateStatus('waiting', 'Captura cancelada');
      return;
    }

    isSharing = true;

    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        console.log('Compartilhamento interrompido via barra nativa.');
        stopScreenSharing();
      };
      applyContentHint(qualityConfig.contentHint);
    }

    // Preview local
    elements.remoteVideo.srcObject = localStream;
    elements.remoteVideo.muted = true;
    elements.remoteVideo.classList.remove('hidden');
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
    } else {
      elements.audioStatusText.textContent = 'Sem Audio';
      elements.audioStatusIcon.setAttribute('data-lucide', 'volume-x');
    }

    elements.iconToggleShare.setAttribute('data-lucide', 'square');
    elements.textToggleShare.textContent = 'Interromper Transmissao';
    elements.btnToggleShare.classList.replace('bg-brand-600', 'bg-red-600');
    elements.btnToggleShare.classList.replace('hover:bg-brand-500', 'hover:bg-red-500');

    updateStatus('sharing', 'Transmitindo Ao Vivo');
    showToast('Transmissao iniciada em ' + modeLabel + '!');

    activeDataConns.forEach((dataConn, viewerPeerId) => {
      peer.call(viewerPeerId, localStream);
    });

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

/**
 * Seletor de fontes + captura de audio com exclusao de processo.
 */
function captureElectronScreen(utils) {
  return new Promise(async (resolve) => {
    const withTimeout = utils.withTimeout;
    const stopAllTracks = utils.stopAllTracks;
    let screenVideoStream = null;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const sources = await window.electronAPI.getDesktopSources();
      if (!sources || sources.length === 0) {
        showToast('Nenhuma tela ou janela encontrada.');
        return finish(null);
      }

      elements.sourcesGrid.innerHTML = '';

      sources.forEach((src) => {
        const card = document.createElement('div');
        card.className =
          'glass-panel p-2.5 rounded-xl border border-gray-800 hover:border-brand-500 ' +
          'cursor-pointer flex flex-col gap-2 group transition-all hover:bg-gray-800/60 relative';

        const isScreen = src.isScreen;
        const isDiscordApp = src.isDiscord;

        card.innerHTML =
          '<div class="relative w-full aspect-video rounded-lg overflow-hidden bg-black/80 ' +
          'flex items-center justify-center">' +
          '<img src="' + src.thumbnail + '" class="w-full h-full object-contain" alt="' +
          escapeHtml(src.name) + '" />' +
          (isScreen
            ? '<span class="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-brand-500/90 ' +
              'text-white font-mono text-[9px] font-bold">TELA INTEIRA</span>'
            : '') +
          (isDiscordApp
            ? '<span class="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-discord-500 ' +
              'text-white font-mono text-[9px] font-bold">DISCORD</span>'
            : '') +
          '</div>' +
          '<div class="flex items-center gap-2">' +
          (src.appIcon ? '<img src="' + src.appIcon + '" class="w-4 h-4 rounded flex-shrink-0" />' : '') +
          '<span class="text-xs text-gray-200 font-medium truncate" title="' +
          escapeHtml(src.name) + '">' + escapeHtml(src.name) + '</span></div>';

        card.onclick = async () => {
          elements.electronSourceModal.classList.add('hidden');

          try {
            if (isDiscordApp) {
              showToast('Captura do Discord bloqueada para nao transmitir a voz de ninguem.');
              return finish(null);
            }

            // 1. Video sempre sem audio do sistema (o audio entra depois, filtrado)
            updateStatus('connecting', 'Iniciando captura de video...');
            screenVideoStream = await withTimeout(
              navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: src.id,
                    maxWidth: qualityConfig.width,
                    maxHeight: qualityConfig.height,
                    maxFrameRate: qualityConfig.fps
                  }
                }
              }),
              10000,
              'video da fonte',
              stopAllTracks
            );

            // 2. Audio do sistema (nativo com exclusao, ou loopback como fallback)
            updateStatus('connecting', 'Preparando audio...');
            const audioMode = elements.selectAudioSourceApp
              ? elements.selectAudioSourceApp.value
              : 'native';
            const audioResult = await buildAudioTrack(audioMode);

            const finalStream = new MediaStream();
            screenVideoStream.getVideoTracks().forEach((vt) => finalStream.addTrack(vt));

            if (audioResult.track) {
              finalStream.addTrack(audioResult.track);
              showToast(
                audioResult.mode === 'native'
                  ? 'Audio capturado com o Discord EXCLUIDO (' +
                    (audioResult.excludedPids || []).length + ' PID).'
                  : 'Audio do sistema capturado.'
              );
            } else {
              showToast(
                'Video sem audio: o sistema nao liberou captura de audio. ' +
                'Verifique as permissoes de som do Windows.'
              );
            }

            return finish(finalStream);
          } catch (err) {
            console.error('Erro ao capturar fonte:', err);
            stopAllTracks(screenVideoStream);
            showToast('Erro ao iniciar captura da fonte selecionada.');
            return finish(null);
          }
        };

        elements.sourcesGrid.appendChild(card);
      });

      elements.electronSourceModal.classList.remove('hidden');

      const closeModal = () => {
        elements.electronSourceModal.classList.add('hidden');
        finish(null);
      };
      elements.btnCloseSourceModal.onclick = closeModal;
      elements.btnCancelSourceModal.onclick = closeModal;
    } catch (err) {
      console.error('Erro ao listar fontes:', err);
      finish(null);
    }
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Encerramento
// ---------------------------------------------------------------------------

function stopScreenSharing() {
  teardownAudioMeter();

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      try { track.stop(); } catch (e) { /* ignora */ }
    });
    localStream = null;
  }

  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    isMicActive = false;
  }

  if (window.NativeAudioBridge) {
    window.NativeAudioBridge.stop().catch(() => {});
  }

  isSharing = false;
  elements.remoteVideo.srcObject = null;
  elements.remoteVideo.classList.add('hidden');
  elements.videoPlaceholder.classList.remove('hidden');
  elements.liveOverlay.classList.add('hidden');
  elements.liveOverlay.classList.remove('flex');

  activeDataConns.forEach((dataConn) => {
    try { dataConn.send({ type: 'stream-stopped' }); } catch (e) { /* ignora */ }
  });

  elements.iconToggleShare.setAttribute('data-lucide', 'screen-share');
  elements.textToggleShare.textContent = 'Iniciar Compartilhamento';
  elements.btnToggleShare.classList.replace('bg-red-600', 'bg-brand-600');
  elements.btnToggleShare.classList.replace('hover:bg-red-500', 'hover:bg-brand-500');

  updateStatus('waiting', 'Sala Pronta (Aguardando)');
  stopAdaptiveBitrateMonitor();
  showToast('Transmissao de tela encerrada.');
  refreshIcons();
}

// ---------------------------------------------------------------------------
// Controles de audio
// ---------------------------------------------------------------------------

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

async function toggleMicrophoneCapture() {
  if (!isHost) return;

  if (isMicActive) {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    isMicActive = false;
    elements.iconToggleMic.setAttribute('data-lucide', 'mic-off');
    elements.iconToggleMic.className = 'w-4 h-4 text-gray-400';
    elements.textToggleMic.textContent = 'Microfone Desativado';
    showToast('Microfone da transmissao desativado.');
  } else {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const micTrack = micStream.getAudioTracks()[0];

      if (localStream) {
        localStream.addTrack(micTrack);
        // O espectador precisa receber a nova track sem reconectar.
        replaceAudioTrackOnSenders(micTrack).then((n) => {
          if (n > 0) console.log('replaceTrack de microfone em', n, 'sender(s)');
        });
      }

      isMicActive = true;
      elements.iconToggleMic.setAttribute('data-lucide', 'mic');
      elements.iconToggleMic.className = 'w-4 h-4 text-emerald-400';
      elements.textToggleMic.textContent = 'Microfone Ativo';
      showToast('Microfone adicionado a transmissao!');
    } catch (err) {
      console.error('Erro ao acessar microfone:', err);
      showToast('Permissao de microfone negada ou indisponivel.');
    }
  }
  refreshIcons();
}

// ---------------------------------------------------------------------------
// Bitrate
// ---------------------------------------------------------------------------

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

    let totalPacketsLost = 0;
    let totalPacketsSent = 0;

    try {
      for (const connList of Object.values(peer.connections || {})) {
        for (const conn of connList || []) {
          const pc = conn && conn.peerConnection;
          if (!pc) continue;
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              totalPacketsSent += report.packetsSent || 0;
            }
            if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
              totalPacketsLost += report.packetsLost || 0;
            }
          });
        }
      }
    } catch (e) {
      return;
    }

    const lossRate = totalPacketsSent > 0 ? (totalPacketsLost / totalPacketsSent) : 0;

    if (lossRate > 0.05) {
      consecutiveBadReports++;
      if (consecutiveBadReports >= 2) {
        const reduced = Math.max(Math.floor(currentBitrate * 0.75), 600000);
        if (reduced < currentBitrate) {
          currentBitrate = reduced;
          applyDynamicWebRTCBitrate(currentBitrate);
          console.warn('[Adaptativo] Bitrate reduzido para ' +
            Math.round(currentBitrate / 1000) + ' kbps');
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