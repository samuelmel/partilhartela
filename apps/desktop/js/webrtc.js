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
  roomHostPeerId = hostPeerId;

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
        console.log('[audio-check] localStream: video=' +
          localStream.getVideoTracks().length + ' audio=' +
          localStream.getAudioTracks().length + ' (sistema=' +
          getSystemAudioTracks(localStream).length + ')');
        ensureSystemAudioTrackReady(localStream, 'novo espectador');
        const mediaCall = peer.call(dataConn.peer, localStream);
        // O sender de audio so existe depois da renegociacao: espera um pouco.
        setTimeout(() => auditConnectionAudio('novo espectador'), 1500);
        setTimeout(() => applyDynamicWebRTCBitrate(qualityConfig.bitrateBps), 500);
      }
    });

    dataConn.on('data', (data) => {
      if (data && data.type === 'stream-stopped' && !isSharing) {
        showViewerWaitingState('O participante interrompeu o compartilhamento de tela.');
      }
    });

    dataConn.on('close', () => {
      activeDataConns.delete(dataConn.peer);
      updateViewerCount();
    });
  });

  peer.on('call', (call) => {
    const responseStream = isSharing && localStream ? localStream : undefined;
    if (responseStream) ensureSystemAudioTrackReady(responseStream, 'call answered');
    call.answer(responseStream);
    call.on('stream', (incomingStream) => {
      relayPublishedStream(incomingStream, call.peer);
    });
    call.on('close', () => {
      if (!isSharing) showViewerWaitingState('Transmissao encerrada.');
    });
    call.on('error', (err) => console.error('Erro na publicacao recebida:', err));
    setTimeout(() => auditConnectionAudio('call answered'), 1500);
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
    try {
      peer.call(participantPeerId, stream);
    } catch (err) {
      console.error('Erro ao retransmitir stream publicada:', err);
    }
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
 * Decide se o audio vem do addon nativo.
 *
 * Se o addon responder positively, o video e capturado SO (audio:false) e a
 * track nativa e acrescida depois. Se nao, o audio entra JUNTO com o video
 * numa unica chamada getUserMedia, amarrada ao chromeMediaSourceId.
 *
 * @returns {Promise<{useNative:boolean, track:?MediaStreamTrack,
 *                    excludedPids:number[], reason:?string}>}
 */
async function resolveAudioStrategy(audioMode) {
  if (audioMode === 'system' || !isElectron) {
    return {
      useNative: false, track: null, excludedPids: [], filtered: false,
      warning: null, reason: null
    };
  }

  try {
    const pidInfo = await window.electronAPI.getExcludedPids();
    const pids = pidInfo && Array.isArray(pidInfo.pids) ? pidInfo.pids : [];
    audioStrategy.excludedPids = pids;

    if (elements.discordStatusDot) {
      if (pidInfo && pidInfo.isRunning) {
        elements.discordStatusDot.className =
          'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
        elements.discordStatusMsg.textContent =
          'Discord detectado (' + pidInfo.count +
          ' processo(s)) - audio sera EXCLUIDO';
      } else {
        elements.discordStatusDot.className =
          'w-2.5 h-2.5 rounded-full bg-gray-500';
        elements.discordStatusMsg.textContent = 'Discord nao esta aberto no momento';
      }
    }

    const result = await window.NativeAudioBridge.start({ excludedPids: pids });

    if (result.ok) {
      audioStrategy.filtered = Boolean(result.filtered);
      audioStrategy.modeWarning = result.warning || null;
      updateAudioFilterBadge(pids, true, null, audioStrategy.filtered);
      return {
        useNative: true,
        track: result.track,
        excludedPids: pids,
        filtered: audioStrategy.filtered,
        warning: audioStrategy.modeWarning,
        reason: null
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

  return {
    useNative: false, track: null,
    excludedPids: audioStrategy.excludedPids,
    filtered: false,
    warning: null,
    reason: audioStrategy.lastError
  };
}

/**
 * Kind (audio/video) de um sender, mesmo sem track.
 *
 * Nao existe `sender.kind` na API padrao: com faixa nula (m-line negociado
 * para envio mas sem faixa) o caminho correto e o transceiverreceiver.
 */
function senderKind(pc, sender) {
  if (!sender) return null;
  if (sender.track) return sender.track.kind;
  try {
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
    if (transceiver && transceiver.receiver && transceiver.receiver.track) {
      return transceiver.receiver.track.kind;
    }
  } catch (err) {
    /* getTransceivers indisponivel: cai para o campo legado */
  }
  return sender._initialKind || null;
}

/**
 * Inventario de senders de audio de uma conexao.
 *
 * O m-line de audio do WebRTC carrega UMA faixa por negotiated renegotiation.
 * O log confirma que a faixa do sistema permanece presente e ativa.
 *
 * @returns {number} quantidade de senders de audio com track
 */
function logAudioSenders(label, pc) {
  if (!pc) return 0;
  const senders = pc.getSenders();
  const audioSenders = senders.filter((s) => s.track && s.track.kind === 'audio');
  const audioLivres = senders.filter((s) => !s.track && senderKind(pc, s) === 'audio');
  console.log(`[audio-check] ${label}: senders=${senders.length} ` +
    `audio_com_track=${audioSenders.length} audio_sem_track=${audioLivres.length}`);
  audioSenders.forEach((s, i) => {
    const st = s.track.getSettings ? s.track.getSettings() : {};
    console.log(`[audio-check]   audio#${i} label="${s.track.label}" ` +
      `enabled=${s.track.enabled} readyState=${s.track.readyState} ` +
      `deviceId=${st.deviceId || '-'}`);
  });
  return audioSenders.length;
}

/** Inventario de audio em todas as conexoes ativas. */
function auditConnectionAudio(label) {
  if (!peer || !peer.connections) return 0;
  let total = 0;
  Object.entries(peer.connections || {}).forEach(([peerId, list]) => {
    (list || []).forEach((conn, i) => {
      total += logAudioSenders(`${label} ${peerId}#${i}`, conn && conn.peerConnection);
    });
  });
  console.log(`[audio-check] ${label}: total de senders de audio com track = ${total}`);
  return total;
}

/** Rotulo legivel de uma faixa de audio do sistema. */
function systemAudioLabel(track) {
  if (!track) return 'nenhuma';
  return track.label || 'loopback';
}

/** Todas as faixas de audio da captura de tela. */
function getSystemAudioTracks(stream) {
  if (!stream) return [];
  return stream.getAudioTracks();
}

/** Confirma que a faixa de audio do sistema esta pronta antes do envio. */
function ensureSystemAudioTrackReady(stream, context) {
  const systemAudioTrack = stream && stream.getAudioTracks()[0];
  if (systemAudioTrack && systemAudioTrack.readyState === 'live') {
    systemAudioTrack.enabled = true;
    console.log('[sistema-audio] Faixa do sistema pronta para envio:',
      systemAudioTrack.label, context ? '(' + context + ')' : '');
  } else {
    console.warn('[sistema-audio] ALERTA: Faixa de áudio do sistema indisponível na stream local!');
  }
  return systemAudioTrack;
}

/**
 * Envia o audio do sistema pelos senders de audio ja negociados.
 *
 * @returns {Promise<number>} conexoes atualizadas
 */
async function replaceAudioTrackOnSenders(newTrack) {
  if (!peer || !newTrack) return 0;

  ensureSystemAudioTrackReady(localStream, 'replaceTrack');
  let replaced = 0;

  Object.values(peer.connections || {}).forEach((connectionList) => {
    (connectionList || []).forEach((conn) => {
      const pc = conn && conn.peerConnection;
      if (!pc) return;

      let touched = false;
      pc.getSenders().forEach((sender) => {
        const isAudio = senderKind(pc, sender) === 'audio';
        if (!isAudio) return;
        if (sender.track === newTrack) return;

        sender.replaceTrack(newTrack).then(() => {
          touched = true;
        }).catch((err) => {
          console.warn('Falha no replaceTrack do audio do sistema:', err);
        });
      });

      if (touched || newTrack) replaced++;
    });
  });

  auditConnectionAudio('audio do sistema enviado');
  return replaced;
}

/**
 * Desliga o processamento de audio na faixa do sistema.
 *
 * Mantem o loopback sem filtros de processamento de voz.
 */
function hardenSystemAudioTrack(track) {
  if (!track) return Promise.resolve(null);

  const wanted = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    googEchoCancellation: false,
    googAutoGainControl: false,
    googNoiseSuppression: false,
    googHighpassFilter: false
  };

  const log = (stage) => {
    const st = track.getSettings ? track.getSettings() : {};
    console.log(`[audio] ${stage}: label="${track.label}" ` +
      `EC=${st.echoCancellation} NS=${st.noiseSuppression} ` +
      `AGC=${st.autoGainControl}`);
  };

  log('audio do sistema');

  if (typeof track.applyConstraints !== 'function') {
    return Promise.resolve(track);
  }

  return track.applyConstraints(wanted)
    .then(() => { log('pos applyConstraints'); return track; })
    .catch((err) => {
      console.warn('[audio] applyConstraints recusado na faixa do sistema:', err);
      return track;
    });
}

/** Limiar de audio audivel: ~-66 dBFS (mesmo criterio do probe de captura). */
const AUDIBLE_RMS = 0.0005;

/**
 * Mede o RMS de pico de uma faixa de audio.
 *
 * Rotulo de track nao prova conteudo: `deviceId: loopback` aparece em qualquer
 * audio de desktop, inclusive numa faixa muda. So o sinal medido diz se o
 * YouTube/jogo realmente esta entrando.
 *
 * @returns {Promise<number>} RMS de pico, ou -1 se nao deu para medir
 */
async function measureTrackRms(track, ms) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor || !track) return -1;

  const ctx = new Ctor();
  try {
    if (ctx.state === 'suspended') await ctx.resume();

    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // Ganho 0: o no precisa estar conectado para ser processado.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    analyser.connect(mute);
    mute.connect(ctx.destination);

    const buf = new Float32Array(analyser.fftSize);
    let maxRms = 0;
    const deadline = performance.now() + ms;

    while (performance.now() < deadline) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (rms > maxRms) maxRms = rms;
      await new Promise((r) => setTimeout(r, 40));
    }

    try { source.disconnect(); mute.disconnect(); } catch (e) { /* ignora */ }
    return maxRms;
  } catch (err) {
    return -1;
  } finally {
    try { await ctx.close(); } catch (e) { /* ignora */ }
  }
}

/**
 * Descobre a melhor faixa de audio do sistema para a fonte escolhida.
 *
 * O Chromium nao isola audio por janela: amarrar o audio ao id de uma JANELA
 * costuma devolver faixa muda. Amarrado a uma TELA, vem o loopback global. Por
 * isso os candidatos sao testados e medidos - e o primeiro com sinal real
 * vence, em vez de confiar no primeiro que "nao deu erro".
 *
 * @returns {Promise<?{track:MediaStreamTrack, via:string, rms:number}>}
 */
async function captureSystemAudioForSource(src, allSources, withTimeout,
                                           stopAllTracks) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const canMeasure = Boolean(Ctor);
  let fallback = null;

  // Candidatos de origem, na ordem de preferencia.
  const screenSrc = (allSources || []).find((s) => s.isScreen);
  const candidates = [];
  if (src && src.isScreen) {
    candidates.push({ id: src.id, via: 'tela' });
  } else {
    if (screenSrc) candidates.push({ id: screenSrc.id, via: 'tela (global)' });
    if (src) candidates.push({ id: src.id, via: 'janela' });
  }

  const attempt = async (candidate) => {
    // NUNCA audio sem video: audio isolado de desktop derruba o renderer.
    const temp = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: candidate.id,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            googEchoCancellation: false,
            googAutoGainControl: false,
            googNoiseSuppression: false,
            googHighpassFilter: false
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: candidate.id,
            maxWidth: 320,
            maxHeight: 180,
            maxFrameRate: 5
          }
        }
      }),
      8000,
      'audio via ' + candidate.via,
      stopAllTracks
    );

    const track = temp.getAudioTracks()[0];
    if (!track) {
      stopAllTracks(temp);
      return null;
    }
    temp.getVideoTracks().forEach((t) => t.stop());
    await hardenSystemAudioTrack(track);

    if (!canMeasure) {
      return { track, via: candidate.via, rms: -1 };
    }

    const rms = await measureTrackRms(track, 700);
    if (rms > AUDIBLE_RMS) {
      return { track, via: candidate.via, rms };
    }
    console.warn('[audio] via ' + candidate.via + ' veio muda (rms=' +
      rms.toFixed(5) + '): descartando');
    try { track.stop(); } catch (e) { /* ignora */ }
    return null;
  };

  for (const candidate of candidates) {
    try {
      const found = await attempt(candidate);
      if (found) {
        if (found.rms > AUDIBLE_RMS) {
          console.log('[audio] capturado via ' + found.via + ' rms=' +
            found.rms.toFixed(5));
          return found;
        }
        // Faixa existe mas estava muda: guarda como reserva. Se NADA tiver
        // sinal (nada tocando no momento), ela ainda e melhor que video
        // mudo - medir ordena as opcoes, nao decide por elas.
        if (!fallback) {
          fallback = found;
          console.warn('[audio] via ' + found.via + ' veio muda no teste ' +
            '(rms=' + found.rms.toFixed(5) + '): guardada como reserva');
        } else {
          try { found.track.stop(); } catch (e) { /* ignora */ }
        }
      }
    } catch (err) {
      console.warn('[audio] via ' + candidate.via + ' falhou: ' +
        (err && err.message));
    }
  }

  if (fallback) {
    showToast('Áudio capturado, mas nenhum sinal foi detectado na medição ' +
      '(nada tocando?). Se o espectador não ouvir, toque um som e reinicie o ' +
      'compartilhamento.');
    return fallback;
  }

  // Ultimo recurso: getDisplayMedia com loopback global, via handler do main
  // (que ja escolhe a primeira tela e evita o dialogo nativo).
  try {
    const temp = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false
      }
    });
    const track = temp.getAudioTracks()[0];
    if (track) {
      temp.getVideoTracks().forEach((t) => t.stop());
      await hardenSystemAudioTrack(track);
      const rms = canMeasure ? await measureTrackRms(track, 700) : -1;
      console.log('[audio] capturado via getDisplayMedia rms=' +
        (rms >= 0 ? rms.toFixed(5) : 'n/d'));
      return { track, via: 'getDisplayMedia', rms };
    }
    stopAllTracks(temp);
  } catch (err) {
    console.warn('[audio] getDisplayMedia falhou: ' + (err && err.message));
  }

  return null;
}

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
      console.log('[audio] faixa capturada: ' + systemAudioLabel(audioTrack) +
        ' | sistema=' + getSystemAudioTracks(localStream).length +
        ' | estado=' + audioTrack.readyState);
      setupAudioMeter(localStream);
    }
    // Sincroniza botao, badge e icone com as tracks REAIS da stream.
    applyAudioTrackState(Boolean(audioTrack));

    elements.iconToggleShare.setAttribute('data-lucide', 'square');
    elements.textToggleShare.textContent = 'Interromper Transmissao';
    elements.btnChangeSource.classList.remove('hidden');
    elements.btnChangeSource.classList.add('flex');
    elements.btnToggleShare.classList.replace('bg-brand-600', 'bg-red-600');
    elements.btnToggleShare.classList.replace('hover:bg-brand-500', 'hover:bg-red-500');

    updateStatus('sharing', 'Transmitindo Ao Vivo');
    showToast('Transmissao iniciada em ' + modeLabel + '!');

    ensureSystemAudioTrackReady(localStream, 'transmissao inicial');
    if (isHost) {
      activeDataConns.forEach((dataConn, viewerPeerId) => {
        peer.call(viewerPeerId, localStream);
      });
    } else if (roomHostPeerId) {
      activeCall = peer.call(roomHostPeerId, localStream);
    }
    setTimeout(() => auditConnectionAudio('espectadores conectados'), 1500);

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

/** Troca apenas a fonte de video e preserva a transmissao atual. */
async function switchScreenSource() {
  if (!isHost || !isSharing || !localStream) return;

  const oldStream = localStream;
  const reusedAudioTrack = oldStream.getAudioTracks()[0];
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

  elements.btnChangeSource.disabled = true;
  updateStatus('connecting', 'Preparando nova fonte...');

  try {
    const nextStream = await captureElectronScreen({
      withTimeout,
      stopAllTracks
    }, { reuseAudioTrack: reusedAudioTrack });

    if (!nextStream) {
      updateStatus('sharing', 'Transmitindo Ao Vivo');
      return;
    }

    const nextVideoTrack = nextStream.getVideoTracks()[0];
    if (!nextVideoTrack) {
      stopAllTracks(nextStream);
      throw new Error('A nova fonte nao forneceu video');
    }

    const replacements = [];
    Object.values(peer.connections || {}).forEach((connectionList) => {
      (connectionList || []).forEach((conn) => {
        const pc = conn && conn.peerConnection;
        if (!pc) return;
        pc.getSenders().forEach((sender) => {
          if (sender.track && sender.track.kind === 'video') {
            replacements.push(sender.replaceTrack(nextVideoTrack));
          }
        });
      });
    });
    await Promise.all(replacements);

    nextVideoTrack.onended = () => {
      console.log('Compartilhamento interrompido via barra nativa.');
      stopScreenSharing();
    };
    applyContentHint(qualityConfig.contentHint);

    localStream = nextStream;
    attachLocalStream(nextStream);
    ensureSystemAudioTrackReady(nextStream, 'troca de fonte');
    applyAudioTrackState(Boolean(nextStream.getAudioTracks()[0]));

    oldStream.getTracks().forEach((track) => {
      if (!nextStream.getTracks().includes(track)) {
        try { track.stop(); } catch (e) { /* ignora */ }
      }
    });

    const settings = nextVideoTrack.getSettings();
    elements.qualityStats.textContent =
      (window.StreamP2P
        ? window.StreamP2P.Quality.labelFor(currentMode)
        : currentMode) + ': ' + (settings.height || qualityConfig.height) +
      'p @ ' + Math.round(settings.frameRate || qualityConfig.fps) + 'FPS';
    updateStatus('sharing', 'Transmitindo Ao Vivo');
    showToast('Fonte de transmissão alterada sem interromper a sala.');
    auditConnectionAudio('apos troca de fonte');
  } catch (err) {
    console.error('Erro ao trocar fonte:', err);
    updateStatus('sharing', 'Transmitindo Ao Vivo');
    showToast('Nao foi possivel trocar a fonte: ' + err.message);
  } finally {
    elements.btnChangeSource.disabled = false;
    refreshIcons();
  }
}

/**
 * Seletor de fontes + captura de audio com exclusao de processo.
 */
function captureElectronScreen(utils, options) {
  return new Promise(async (resolve) => {
    const withTimeout = utils.withTimeout;
    const stopAllTracks = utils.stopAllTracks;
    const reusedAudioTrack = options && options.reuseAudioTrack &&
      options.reuseAudioTrack.readyState === 'live'
      ? options.reuseAudioTrack
      : null;
    let screenVideoStream = null;
    let screenAudioStream = null;
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

            // Guarda a fonte escolhida: permite re-capturar o audio depois
            // sem derrubar a transmissao inteira.
            currentSourceId = src.id;

            // 1. Decide a estrategia de audio ANTES de capturar.
            //    Sem o addon nativo, o audio precisa vir na MESMA chamada do
            //    video: getUserMedia so com audio desktop manda uma IPC invalida
            //    ao Chromium e mata o renderer (bad_message.cc, reason 263).
            updateStatus('connecting', 'Preparando captura...');
            const audioMode = elements.selectAudioSourceApp
              ? elements.selectAudioSourceApp.value
              : 'native';
            const audioPlan = reusedAudioTrack
              ? {
                  useNative: true,
                  track: reusedAudioTrack,
                  filtered: audioStrategy.filtered,
                  excludedPids: audioStrategy.excludedPids,
                  warning: audioStrategy.modeWarning
                }
              : await resolveAudioStrategy(audioMode);

            const videoConstraints = {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: src.id,
                maxWidth: qualityConfig.width,
                maxHeight: qualityConfig.height,
                maxFrameRate: qualityConfig.fps
              }
            };

            // 2. Captura. No modo nativo o video vem sozinho (audio:false) e a
            //    track filtrada e acrescida depois.
            updateStatus('connecting',
              audioPlan.useNative ? 'Iniciando captura de video...'
                : 'Iniciando captura de video e audio...');

            if (audioPlan.useNative) {
              screenVideoStream = await withTimeout(
                navigator.mediaDevices.getUserMedia({
                  audio: false,
                  video: videoConstraints
                }),
                10000,
                'video da fonte',
                stopAllTracks
              );
            } else {
              // O VIDEO fica amarrado a fonte escolhida (janela ou tela).
              // O AUDIO e procurado a parte e medido: amarrar audio ao id de
              // uma JANELA costuma devolver faixa muda, porque o Chromium nao
              // isola audio por janela. Com audio na tela vem o loopback
              // global, que e o que o usuario espera.
              screenVideoStream = await withTimeout(
                navigator.mediaDevices.getUserMedia({
                  audio: false,
                  video: videoConstraints
                }),
                10000,
                'video da fonte',
                stopAllTracks
              );

              const found = await captureSystemAudioForSource(
                src, sources, withTimeout, stopAllTracks
              );
              if (found) {
                screenAudioStream = new MediaStream();
                screenAudioStream.addTrack(found.track);
              }
            }

            // 3. Monta o stream final
            const finalStream = new MediaStream();
            screenVideoStream.getVideoTracks().forEach((vt) => finalStream.addTrack(vt));

            if (audioPlan.useNative && audioPlan.track) {
              finalStream.addTrack(audioPlan.track);
              if (audioPlan.filtered) {
                showToast('Áudio capturado com o Discord EXCLUÍDO (' +
                  (audioPlan.excludedPids || []).length + ' PID).');
              } else {
                showToast(audioPlan.warning ||
                  'Áudio do sistema capturado sem o filtro do Discord.');
              }
            } else if (screenAudioStream) {
              finalStream.addTrack(screenAudioStream.getAudioTracks()[0]);
              const s = screenAudioStream.getAudioTracks()[0].getSettings();
              console.log('[audio] origem=' +
                screenAudioStream.getAudioTracks()[0].label +
                ' deviceId=' + s.deviceId + ' canais=' + s.channelCount);
              showToast('Áudio do sistema capturado via loopback (' +
                'dispositivo de saída padrão). Se um app tocar em outro ' +
                'dispositivo, reinicie o compartilhamento.');
            } else {
              showToast('Vídeo sem áudio: nenhuma via de captura devolveu ' +
                'sinal. Tocar som antes de iniciar pode ajudar.');
            }

            return finish(finalStream);
          } catch (err) {
            console.error('Erro ao capturar fonte:', err);
            stopAllTracks(screenVideoStream);
            stopAllTracks(screenAudioStream);
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
  isAudioMuted = false;
  currentSourceId = null;
  applyAudioTrackState(false);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      try { track.stop(); } catch (e) { /* ignora */ }
    });
    localStream = null;
  }
  removeLocalStream();

  if (window.NativeAudioBridge) {
    window.NativeAudioBridge.stop().catch(() => {});
  }

  isSharing = false;

  activeDataConns.forEach((dataConn) => {
    try { dataConn.send({ type: 'stream-stopped' }); } catch (e) { /* ignora */ }
  });

  elements.iconToggleShare.setAttribute('data-lucide', 'screen-share');
  elements.textToggleShare.textContent = isHost
    ? 'Iniciar Compartilhamento'
    : 'Compartilhar Minha Tela';
  elements.btnChangeSource.classList.add('hidden');
  elements.btnChangeSource.classList.remove('flex');
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

/**
 * Re-captura o audio do sistema durante a transmissao.
 *
 * IMPORTANTE: nunca chamar getUserMedia com audio de desktop e video:false.
 * No Electron isso derruba o renderer (bad_message.cc, reason 263) - ver
 * README secao 8 e o teste C de `npm run probe:capture`.
 *
 * O caminho seguro e pedir audio E video juntos com o mesmo sourceId (teste B
 * do probe, comprovado), ficar so com a faixa de audio e descartar a de video.
 *
 * @returns {Promise<?MediaStreamTrack>}
 */
async function recaptureSystemAudio() {
  if (!currentSourceId) {
    return null;
  }

  const Utils = window.StreamP2P ? window.StreamP2P.Utils : null;
  const stopAllTracks = Utils
    ? Utils.stopAllTracks
    : (s) => s && s.getTracks && s.getTracks().forEach((t) => t.stop());

  // Caminho 1: audio+video juntos (seguro, estéreo, sem processamento).
  try {
    const temp = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: currentSourceId,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          googEchoCancellation: false,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: currentSourceId,
          maxWidth: 320,
          maxHeight: 180,
          maxFrameRate: 5
        }
      }
    });

    const track = temp.getAudioTracks()[0];
    if (track) {
      // A faixa de video era so um placebo para satisfazer o Chromium.
      temp.getVideoTracks().forEach((t) => t.stop());
      await hardenSystemAudioTrack(track);
      const s = track.getSettings();
      console.log('[audio] re-capturado: label="' + track.label +
        '" deviceId=' + s.deviceId + ' canais=' + s.channelCount);
      return track;
    }
    stopAllTracks(temp);
  } catch (err) {
    console.warn('[audio] re-captura conjunta falhou:', err);
  }

  // Caminho 2: getDisplayMedia, que passa pelo handler do main.
  // Entrega loopback em mono e com EC/AGC/NS ligados - pior qualidade, mas
  // melhor que ficar sem audio.
  try {
    const temp = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false
      }
    });

    const track = temp.getAudioTracks()[0];
    if (track) {
      temp.getVideoTracks().forEach((t) => t.stop());
      await hardenSystemAudioTrack(track);
      console.warn('[audio] re-captura via getDisplayMedia (mono, com ' +
        'processamento automatico).');
      return track;
    }
    stopAllTracks(temp);
  } catch (err) {
    console.warn('[audio] re-captura via getDisplayMedia falhou:', err);
  }

  return null;
}

async function toggleAudioTrack() {
  if (!isHost || !localStream) return;

  // O botao controla somente as faixas do audio do sistema.
  let systemTracks = getSystemAudioTracks(localStream);

  // Sem faixa de audio: tenta recuperar antes de desistir.
  if (systemTracks.length === 0) {
    updateStatus('connecting', 'Recuperando audio do sistema...');
    elements.btnToggleAudio.disabled = true;

    const recovered = await recaptureSystemAudio();

    if (recovered) {
      localStream.addTrack(recovered);
      await hardenSystemAudioTrack(recovered);
      systemTracks = getSystemAudioTracks(localStream);

      const pushed = await replaceAudioTrackOnSenders(recovered);

      applyAudioTrackState(true);

      // O espectador so recebe se a conexao ja tiver um m-line de audio.
      // Sem ele, e preciso renegociar; o PeerJS nem sempre consegue.
      showToast(pushed > 0
        ? 'Audio do sistema recuperado e adicionado a transmissao (' +
          pushed + ' conexao(oes)).'
        : 'Audio recuperado localmente. Se o espectador nao ouvir, ' +
          'reinicie o compartilhamento para a renegociacao.');

      updateStatus('sharing', 'Transmitindo Ao Vivo');
      refreshIcons();
      return;
    }

    applyAudioTrackState(false);
    showToast(
      'Nao foi possivel capturar o audio do sistema. ' +
      'Verifique as permissoes de som do Windows ou reinicie o compartilhamento.'
    );
    return;
  }

  isAudioMuted = !isAudioMuted;
  systemTracks.forEach((t) => { t.enabled = !isAudioMuted; });

  console.log('[audio] mute do sistema = ' + isAudioMuted +
    ' em ' + systemTracks.length + ' faixa(s)');

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