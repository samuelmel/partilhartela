/**
 * StreamP2P Desktop - UI: cache de DOM, toasts, status, modais.
 */

'use strict';

let elements = {};

function initDOMElements() {
  elements = {
    landingView: document.getElementById('landingView'),
    roomView: document.getElementById('roomView'),
    firefoxLandingNotice: document.getElementById('firefoxLandingNotice'),
    firefoxRoomNotice: document.getElementById('firefoxRoomNotice'),

    btnCreateRoom: document.getElementById('btnCreateRoom'),
    joinRoomForm: document.getElementById('joinRoomForm'),
    inputRoomCode: document.getElementById('inputRoomCode'),

    displayRoomId: document.getElementById('displayRoomId'),
    shareUrlInput: document.getElementById('shareUrlInput'),
    btnCopyLink: document.getElementById('btnCopyLink'),
    copyBtnText: document.getElementById('copyBtnText'),
    roleText: document.getElementById('roleText'),
    roleBadge: document.getElementById('roleBadge'),
    roomRoleSubtitle: document.getElementById('roomRoleSubtitle'),

    connectionPill: document.getElementById('connectionPill'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),

    remoteVideo: document.getElementById('remoteVideo'),
    remoteAudio: document.getElementById('remoteAudio'),
    audioUnlockOverlay: document.getElementById('audioUnlockOverlay'),
    videoPlaceholder: document.getElementById('videoPlaceholder'),
    placeholderTitle: document.getElementById('placeholderTitle'),
    placeholderDesc: document.getElementById('placeholderDesc'),
    btnPlaceholderStart: document.getElementById('btnPlaceholderStart'),

    liveOverlay: document.getElementById('liveOverlay'),
    qualityBadge: document.getElementById('qualityBadge'),
    qualityStats: document.getElementById('qualityStats'),
    viewerCountOverlay: document.getElementById('viewerCountOverlay'),
    viewerCountText: document.getElementById('viewerCountText'),
    audioStatusBadge: document.getElementById('audioStatusBadge'),
    audioStatusIcon: document.getElementById('audioStatusIcon'),
    audioStatusText: document.getElementById('audioStatusText'),
    audioFilterBadge: document.getElementById('audioFilterBadge'),
    audioFilterText: document.getElementById('audioFilterText'),

    btnToggleShare: document.getElementById('btnToggleShare'),
    iconToggleShare: document.getElementById('iconToggleShare'),
    textToggleShare: document.getElementById('textToggleShare'),

    btnToggleAudio: document.getElementById('btnToggleAudio'),
    iconToggleAudio: document.getElementById('iconToggleAudio'),
    textToggleAudio: document.getElementById('textToggleAudio'),

    btnDiscordGuide: document.getElementById('btnDiscordGuide'),
    discordGuideModal: document.getElementById('discordGuideModal'),
    btnCloseDiscordGuide: document.getElementById('btnCloseDiscordGuide'),
    btnGotItDiscord: document.getElementById('btnGotItDiscord'),

    btnToggleMic: document.getElementById('btnToggleMic'),
    iconToggleMic: document.getElementById('iconToggleMic'),
    textToggleMic: document.getElementById('textToggleMic'),

    btnQualityModal: document.getElementById('btnQualityModal'),
    labelCurrentQuality: document.getElementById('labelCurrentQuality'),
    qualityModal: document.getElementById('qualityModal'),
    btnCloseQualityModal: document.getElementById('btnCloseQualityModal'),
    btnCancelQualityModal: document.getElementById('btnCancelQualityModal'),
    btnApplyQualityModal: document.getElementById('btnApplyQualityModal'),

    presetCardDefault: document.getElementById('presetCardDefault'),
    presetCardJogo: document.getElementById('presetCardJogo'),
    presetCardFilme: document.getElementById('presetCardFilme'),
    presetCardCustom: document.getElementById('presetCardCustom'),
    customModeStatusBadge: document.getElementById('customModeStatusBadge'),

    selectResolution: document.getElementById('selectResolution'),
    selectFps: document.getElementById('selectFps'),
    selectBitrate: document.getElementById('selectBitrate'),
    selectContentHint: document.getElementById('selectContentHint'),

    btnFullscreen: document.getElementById('btnFullscreen'),
    audioMeterContainer: document.getElementById('audioMeterContainer'),
    audioMeterBar: document.getElementById('audioMeterBar'),

    toastNotification: document.getElementById('toastNotification'),
    toastMessage: document.getElementById('toastMessage'),

    electronSourceModal: document.getElementById('electronSourceModal'),
    sourcesGrid: document.getElementById('sourcesGrid'),
    btnCloseSourceModal: document.getElementById('btnCloseSourceModal'),
    btnCancelSourceModal: document.getElementById('btnCancelSourceModal'),
    discordStatusDot: document.getElementById('discordStatusDot'),
    discordStatusMsg: document.getElementById('discordStatusMsg'),
    selectAudioSourceApp: document.getElementById('selectAudioSourceApp')
  };
}

function refreshIcons() {
  if (window.lucide) {
    try {
      window.lucide.createIcons();
    } catch (e) { /* ignora */ }
  }
}

let _toastTimer = null;
function showToast(message, duration = 3500) {
  if (!elements.toastMessage) return;
  elements.toastMessage.textContent = message;
  elements.toastNotification.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    elements.toastNotification.classList.add('hidden');
  }, duration);
}

function updateStatus(state, message) {
  if (!elements.connectionPill) return;
  elements.connectionPill.classList.remove('hidden');
  elements.statusText.textContent = message;

  elements.statusDot.className = 'w-2.5 h-2.5 rounded-full ';
  if (state === 'online' || state === 'sharing') {
    elements.statusDot.classList.add('bg-emerald-500', 'animate-pulse');
  } else if (state === 'waiting' || state === 'connecting') {
    elements.statusDot.classList.add('bg-yellow-500', 'animate-pulse');
  } else if (state === 'error') {
    elements.statusDot.classList.add('bg-red-500');
  } else {
    elements.statusDot.classList.add('bg-gray-500');
  }
}

function updateViewerCount() {
  if (!elements.viewerCountText) return;
  const count = activeDataConns.size;
  elements.viewerCountText.textContent = count + ' espectador(es)';
}

/** Rotulo do filtro de audio nativo (exclusao de processo). */
function updateAudioFilterBadge(pids, available, error) {
  if (!elements.audioFilterText) return;

  if (available && pids && pids.length > 0) {
    elements.audioFilterBadge.classList.remove('hidden');
    elements.audioFilterText.textContent =
      'Áudio do sistema sem Discord (' + pids.length + ' PID excluído' +
      (pids.length > 1 ? 's' : '') + ')';
  } else if (available) {
    elements.audioFilterBadge.classList.remove('hidden');
    elements.audioFilterText.textContent = 'Áudio do sistema (Discord fechado)';
  } else {
    elements.audioFilterBadge.classList.add('hidden');
    if (error) {
      elements.audioFilterText.textContent = '';
    }
  }
}

function configureHostUI() {
  elements.roleText.textContent = 'Transmissor (Host)';
  elements.roleBadge.classList.replace('bg-brand-500/10', 'bg-blue-500/20');
  elements.roleBadge.classList.replace('text-brand-400', 'text-blue-300');
  elements.roomRoleSubtitle.textContent =
    'Voce e o dono da sala. Compartilhe o link para transmitir sua tela.';

  elements.btnToggleShare.classList.remove('hidden');
  elements.btnPlaceholderStart.classList.remove('hidden');
  elements.btnQualityModal.classList.remove('hidden');
  elements.btnToggleMic.classList.remove('hidden');
  elements.btnToggleMic.classList.add('flex');
  elements.viewerCountOverlay.classList.remove('hidden');
  elements.viewerCountOverlay.classList.add('flex');

  elements.placeholderTitle.textContent = 'Pronto para Transmitir';
  elements.placeholderDesc.textContent =
    'Clique em "Iniciar Compartilhamento" para transmitir (' +
    qualityConfig.height + 'p @ ' + qualityConfig.fps + 'FPS).';

  elements.btnToggleShare.onclick = toggleScreenSharing;
  elements.btnPlaceholderStart.onclick = toggleScreenSharing;
  elements.btnToggleAudio.onclick = toggleAudioTrack;

  updateViewerCount();
  refreshIcons();
}

function configureViewerUI() {
  elements.roleText.textContent = 'Espectador (Receptor)';
  elements.roleBadge.classList.replace('bg-brand-500/10', 'bg-purple-500/20');
  elements.roleBadge.classList.replace('text-brand-400', 'text-purple-300');
  elements.roomRoleSubtitle.textContent =
    'Voce esta assistindo a transmissao em tempo real nesta sala.';

  elements.btnToggleShare.classList.add('hidden');
  elements.btnPlaceholderStart.classList.add('hidden');
  elements.btnQualityModal.classList.add('hidden');
  elements.btnToggleMic.classList.add('hidden');
  elements.viewerCountOverlay.classList.add('hidden');

  elements.placeholderTitle.textContent = 'Conectado a Sala';
  elements.placeholderDesc.textContent =
    'Aguardando o transmissor iniciar o compartilhamento de tela...';

  elements.btnToggleAudio.onclick = toggleViewerAudioMute;
  refreshIcons();
}

function showViewerWaitingState(msg) {
  elements.remoteVideo.classList.add('hidden');
  elements.videoPlaceholder.classList.remove('hidden');
  elements.liveOverlay.classList.add('hidden');
  elements.liveOverlay.classList.remove('flex');
  elements.placeholderTitle.textContent = 'Aguardando Transmissao';
  elements.placeholderDesc.textContent = msg;
  updateStatus('waiting', 'Aguardando Video');
}

/**
 * Sincroniza os controles de audio com as tracks REAIS da stream.
 *
 * Um botao que mostra "Audio Ativo" sem nenhuma faixa de audio e o que
 * produz a confusao "Nenhum canal de audio capturado": o usuario clica em
 * algo que parece ativo, mas nao existe track para mutar.
 *
 * @param {boolean} hasAudio
 */
function applyAudioTrackState(hasAudio) {
  const btn = elements.btnToggleAudio;
  const badge = elements.audioStatusBadge;

  // O espectador controla o mute local do video recebido: nao se aplica.
  if (isHost) {
    if (btn) {
      btn.disabled = !hasAudio;
      btn.classList.toggle('opacity-50', !hasAudio);
      btn.classList.toggle('cursor-not-allowed', !hasAudio);
      btn.title = hasAudio
        ? 'Silenciar ou reativar o audio da transmissao'
        : 'Sem audio capturado: clique para tentar recuperar';
    }
  }

  if (hasAudio) {
    elements.iconToggleAudio.setAttribute('data-lucide', 'volume-2');
    elements.iconToggleAudio.className = 'w-4 h-4 text-emerald-400';
    elements.textToggleAudio.textContent = isAudioMuted ? 'Audio Mudo' : 'Audio Ativo';
    elements.audioStatusText.textContent = isAudioMuted ? 'Audio Desativado' : 'Audio Ativo';
    elements.audioStatusIcon.setAttribute('data-lucide', isAudioMuted ? 'volume-x' : 'volume-2');
    if (badge) badge.classList.remove('hidden');
  } else {
    elements.iconToggleAudio.setAttribute('data-lucide', 'volume-x');
    elements.iconToggleAudio.className = 'w-4 h-4 text-gray-500';
    elements.textToggleAudio.textContent = 'Sem Audio';
    elements.audioStatusText.textContent = 'Sem Audio do Sistema';
    elements.audioStatusIcon.setAttribute('data-lucide', 'volume-x');
    if (badge) {
      badge.classList.remove('hidden');
      badge.classList.add('opacity-70');
    }
  }

  refreshIcons();
}

/**
 * Libera o audio no espectador.
 *
 * O Chrome bloqueia audio em autoplay sem gesto do usuario. Com a politica de
 * autoplay, o stream chega mas o video fica mudo: sintoma de "o espectador nao
 * escuta nada" que nao tem nada a ver com a captura no host.
 */
function setupAudioUnlock() {
  const video = elements.remoteVideo;
  const overlay = elements.audioUnlockOverlay;
  if (!video || !overlay) return;

  const unlock = () => {
    video.muted = false;
    video.play().then(() => {
      overlay.classList.add('hidden');
    }).catch(() => {
      // Ainda bloqueado: deixa o overlay visivel.
      overlay.classList.remove('hidden');
    });
  };

  overlay.onclick = unlock;
  video.onclick = () => {
    if (video.paused || video.muted) unlock();
  };

  // Se o playback com audio foi recusado, mostra o overlay.
  video.play().then(() => {
    if (video.muted) overlay.classList.remove('hidden');
  }).catch(() => {
    overlay.classList.remove('hidden');
  });
}

function hideAudioUnlock() {
  if (elements.audioUnlockOverlay) {
    elements.audioUnlockOverlay.classList.add('hidden');
  }
}

function attachRemoteStream(stream) {
  elements.remoteVideo.srcObject = stream;
  elements.remoteVideo.muted = false;
  elements.remoteVideo.classList.remove('hidden');
  elements.videoPlaceholder.classList.add('hidden');
  elements.liveOverlay.classList.remove('hidden');
  elements.liveOverlay.classList.add('flex');

  setupAudioUnlock();

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    const settings = videoTrack.getSettings();
    const actualHeight = settings.height || qualityConfig.height;
    const actualFps = settings.frameRate || qualityConfig.fps;
    elements.qualityStats.textContent =
      actualHeight + 'p @ ' + Math.round(actualFps) + 'FPS';
  }

  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    // Diagnostico: confirma de onde o audio realmente vem.
    const s = audioTrack.getSettings();
    console.log('[audio] track recebida: label="' + audioTrack.label +
      '" deviceId=' + s.deviceId + ' canais=' + s.channelCount +
      ' sampleRate=' + s.sampleRate);

    elements.audioStatusText.textContent = 'Audio Recebido';
    elements.audioStatusIcon.setAttribute('data-lucide', 'volume-2');
    elements.audioStatusBadge.classList.remove('hidden');
  } else {
    elements.audioStatusText.textContent = 'Sem Audio';
    elements.audioStatusIcon.setAttribute('data-lucide', 'volume-x');
  }

  updateStatus('sharing', 'Recebendo Transmissao Ao Vivo');
  refreshIcons();
}

// --- Modal de qualidade (usa o pacote compartilhado) ----------------------

function selectPresetMode(modeKey) {
  currentMode = modeKey;

  [elements.presetCardDefault, elements.presetCardJogo,
    elements.presetCardFilme, elements.presetCardCustom
  ].forEach((card) => {
    if (card) card.classList.remove('active-preset');
  });

  const Quality = window.StreamP2P ? window.StreamP2P.Quality : null;

  if (modeKey === 'jogo') {
    if (elements.presetCardJogo) elements.presetCardJogo.classList.add('active-preset');
    elements.selectResolution.value = '1080';
    elements.selectFps.value = '60';
    elements.selectBitrate.value = '8000000';
    elements.selectContentHint.value = 'motion';
    elements.customModeStatusBadge.textContent = 'Modo: Jogo (60 FPS / 8 Mbps)';
  } else if (modeKey === 'filme') {
    if (elements.presetCardFilme) elements.presetCardFilme.classList.add('active-preset');
    elements.selectResolution.value = '2160';
    elements.selectFps.value = '30';
    elements.selectBitrate.value = '10000000';
    elements.selectContentHint.value = 'detail';
    elements.customModeStatusBadge.textContent =
      'Modo: Filme (4K/1080p @ 30 FPS / 10 Mbps)';
  } else if (modeKey === 'custom') {
    if (elements.presetCardCustom) elements.presetCardCustom.classList.add('active-preset');
    elements.customModeStatusBadge.textContent = 'Modo: Personalizado';
  } else {
    if (elements.presetCardDefault) elements.presetCardDefault.classList.add('active-preset');
    elements.selectResolution.value = '1080';
    elements.selectFps.value = '60';
    elements.selectBitrate.value = '3500000';
    elements.selectContentHint.value = 'motion';
    elements.customModeStatusBadge.textContent = 'Modo: Padrao';
  }

  if (Quality && elements.labelCurrentQuality) {
    elements.labelCurrentQuality.textContent =
      'Modo: ' + Quality.labelFor(modeKey);
  }
}

function onManualSettingChange() {
  selectPresetMode('custom');
}

function openQualityModal() {
  selectPresetMode(currentMode);
  elements.qualityModal.classList.remove('hidden');
}

function closeQualityModal() {
  elements.qualityModal.classList.add('hidden');
}

function applyQualitySettingsFromModal() {
  const Quality = window.StreamP2P ? window.StreamP2P.Quality : null;

  if (Quality) {
    Object.assign(qualityConfig, Quality.fromModalValues(
      elements.selectResolution.value,
      elements.selectFps.value,
      elements.selectBitrate.value,
      elements.selectContentHint.value
    ));
  } else {
    qualityConfig.height = parseInt(elements.selectResolution.value, 10) || 1080;
    qualityConfig.fps = parseInt(elements.selectFps.value, 10) || 60;
    qualityConfig.bitrateBps = parseInt(elements.selectBitrate.value, 10) || 0;
    qualityConfig.contentHint = elements.selectContentHint.value;
  }

  const modeTitle = Quality ? Quality.labelFor(currentMode) : currentMode;
  elements.labelCurrentQuality.textContent = 'Modo: ' + modeTitle;
  elements.qualityStats.textContent = Quality
    ? Quality.describe(qualityConfig, currentMode)
    : modeTitle;

  closeQualityModal();

  if (isSharing && localStream) {
    applyDynamicWebRTCBitrate(qualityConfig.bitrateBps);
    applyContentHint(qualityConfig.contentHint);
    showToast('Modo [' + modeTitle + '] aplicado.');
  } else {
    showToast('Modo [' + modeTitle + '] sera aplicado ao iniciar o compartilhamento.');
  }
}

// --- Medidor de audio ------------------------------------------------------

function setupAudioMeter(stream) {
  try {
    if (!audioContext) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audioContext = new Ctor();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    // Desconecta o source anterior: sem isso, reconexoes acumulam nos de
    // audio e derrubam a sessao depois de um tempo.
    if (_audioMeterSource) {
      try { _audioMeterSource.disconnect(); } catch (e) { /* ignora */ }
      _audioMeterSource = null;
    }

    _audioMeterSource = audioContext.createMediaStreamSource(stream);
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 64;
    _audioMeterSource.connect(audioAnalyser);

    elements.audioMeterContainer.classList.remove('hidden');
    elements.audioMeterContainer.classList.add('flex');

    const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);

    function renderMeter() {
      if (!isSharing || !audioAnalyser) return;
      audioAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const average = sum / dataArray.length;
      const percent = Math.min(100, Math.round((average / 128) * 100));
      elements.audioMeterBar.style.width = percent + '%';
      audioAnimFrame = requestAnimationFrame(renderMeter);
    }
    renderMeter();
  } catch (err) {
    console.warn('Nao foi possivel inicializar o medidor de audio:', err);
  }
}

function teardownAudioMeter() {
  if (audioAnimFrame) {
    cancelAnimationFrame(audioAnimFrame);
    audioAnimFrame = null;
  }
  if (_audioMeterSource) {
    try { _audioMeterSource.disconnect(); } catch (e) { /* ignora */ }
    _audioMeterSource = null;
  }
  audioAnalyser = null;
  if (elements && elements.audioMeterContainer) {
    elements.audioMeterContainer.classList.add('hidden');
  }
}