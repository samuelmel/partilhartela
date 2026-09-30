/**
 * StreamP2P - UI Management, Modals, Toasts & Visualizers
 */

// DOM Elements Cache
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

        // Electron Screen Picker Modal
        electronSourceModal: document.getElementById('electronSourceModal'),
        sourcesGrid: document.getElementById('sourcesGrid'),
        btnCloseSourceModal: document.getElementById('btnCloseSourceModal'),
        btnCancelSourceModal: document.getElementById('btnCancelSourceModal'),
        discordStatusDot: document.getElementById('discordStatusDot'),
        discordStatusMsg: document.getElementById('discordStatusMsg'),
        selectAudioSourceApp: document.getElementById('selectAudioSourceApp')
    };
}

// Helper: Refresh Lucide Icons
function refreshIcons() {
    if (window.lucide) {
        lucide.createIcons();
    }
}

// Helper: Show Toast Notification
function showToast(message, duration = 3500) {
    if (!elements.toastMessage) return;
    elements.toastMessage.textContent = message;
    elements.toastNotification.classList.remove('hidden');
    setTimeout(() => {
        elements.toastNotification.classList.add('hidden');
    }, duration);
}

// Helper: Update Header Connection Status Pill Indicator
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

// Update Connected Viewer Count Display
function updateViewerCount() {
    if (!elements.viewerCountText) return;
    const count = activeDataConns.size;
    elements.viewerCountText.textContent = `${count} espectador(es)`;
}

// Configure Host Role UI Layout
function configureHostUI() {
    elements.roleText.textContent = 'Transmissor (Host)';
    elements.roleBadge.classList.replace('bg-brand-500/10', 'bg-blue-500/20');
    elements.roleBadge.classList.replace('text-brand-400', 'text-blue-300');
    elements.roomRoleSubtitle.textContent = 'Você é o dono da sala. Compartilhe o link para transmitir sua tela.';

    elements.btnToggleShare.classList.remove('hidden');
    elements.btnPlaceholderStart.classList.remove('hidden');
    elements.btnQualityModal.classList.remove('hidden');
    elements.btnToggleMic.classList.remove('hidden');
    elements.btnToggleMic.classList.add('flex');
    elements.viewerCountOverlay.classList.remove('hidden');
    elements.viewerCountOverlay.classList.add('flex');

    elements.placeholderTitle.textContent = 'Pronto para Transmitir';
    elements.placeholderDesc.textContent = `Clique em "Iniciar Compartilhamento" para transmitir (${qualityConfig.height}p @ ${qualityConfig.fps}FPS).`;

    elements.btnToggleShare.onclick = toggleScreenSharing;
    elements.btnPlaceholderStart.onclick = toggleScreenSharing;
    elements.btnToggleAudio.onclick = toggleAudioTrack;

    updateViewerCount();
    refreshIcons();
}

// Configure Viewer Role UI Layout
function configureViewerUI() {
    elements.roleText.textContent = 'Espectador (Receptor)';
    elements.roleBadge.classList.replace('bg-brand-500/10', 'bg-purple-500/20');
    elements.roleBadge.classList.replace('text-brand-400', 'text-purple-300');
    elements.roomRoleSubtitle.textContent = 'Você está assistindo à transmissão em tempo real nesta sala.';

    elements.btnToggleShare.classList.add('hidden');
    elements.btnPlaceholderStart.classList.add('hidden');
    elements.btnQualityModal.classList.add('hidden');
    elements.btnToggleMic.classList.add('hidden');
    elements.viewerCountOverlay.classList.add('hidden');

    elements.placeholderTitle.textContent = 'Conectado à Sala';
    elements.placeholderDesc.textContent = 'Aguardando o transmissor iniciar o compartilhamento de tela...';
    
    elements.btnToggleAudio.onclick = toggleViewerAudioMute;
    refreshIcons();
}

// Show Viewer Waiting State Overlay
function showViewerWaitingState(msg) {
    elements.remoteVideo.classList.add('hidden');
    elements.videoPlaceholder.classList.remove('hidden');
    elements.liveOverlay.classList.add('hidden');
    elements.liveOverlay.classList.remove('flex');
    elements.placeholderTitle.textContent = 'Aguardando Transmissão';
    elements.placeholderDesc.textContent = msg;
    updateStatus('waiting', 'Aguardando Vídeo');
}

// Attach Remote Stream for Viewers
function attachRemoteStream(stream) {
    elements.remoteVideo.srcObject = stream;
    elements.remoteVideo.muted = false;
    elements.remoteVideo.classList.remove('hidden');
    elements.videoPlaceholder.classList.add('hidden');
    elements.liveOverlay.classList.remove('hidden');
    elements.liveOverlay.classList.add('flex');

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
        const settings = videoTrack.getSettings();
        const actualWidth = settings.width || 1920;
        const actualHeight = settings.height || 1080;
        const actualFps = settings.frameRate || 60;
        elements.qualityStats.textContent = `${actualHeight}p @ ${Math.round(actualFps)}FPS`;
    }

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
        elements.audioStatusText.textContent = 'Áudio Recebido';
        elements.audioStatusIcon.setAttribute('data-lucide', 'volume-2');
        elements.audioStatusBadge.classList.remove('hidden');
    } else {
        elements.audioStatusText.textContent = 'Sem Áudio';
        elements.audioStatusIcon.setAttribute('data-lucide', 'volume-x');
    }

    updateStatus('sharing', 'Recebendo Transmissão Ao Vivo');
    refreshIcons();
}

// PRESETS MODAL HANDLERS ('default' | 'jogo' | 'filme' | 'custom')
function selectPresetMode(modeKey) {
    currentMode = modeKey;

    [elements.presetCardDefault, elements.presetCardJogo, elements.presetCardFilme, elements.presetCardCustom].forEach(card => {
        if (card) card.classList.remove('active-preset');
    });

    if (modeKey === 'default') {
        if (elements.presetCardDefault) elements.presetCardDefault.classList.add('active-preset');
        elements.selectResolution.value = '1080';
        elements.selectFps.value = '60';
        elements.selectBitrate.value = '6000000';
        elements.selectContentHint.value = 'motion';
        elements.customModeStatusBadge.textContent = 'Modo: Padrão (Default)';
    } else if (modeKey === 'jogo') {
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
        elements.customModeStatusBadge.textContent = 'Modo: Filme (4K/1080p @ 30 FPS / 10 Mbps)';
    } else if (modeKey === 'custom') {
        if (elements.presetCardCustom) elements.presetCardCustom.classList.add('active-preset');
        elements.customModeStatusBadge.textContent = 'Modo: Personalizado';
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
    const h = parseInt(elements.selectResolution.value, 10);
    const fps = parseInt(elements.selectFps.value, 10);
    const bps = parseInt(elements.selectBitrate.value, 10);
    const hint = elements.selectContentHint.value;

    qualityConfig.height = h;
    qualityConfig.width = h === 2160 ? 3840 : h === 1080 ? 1920 : h === 720 ? 1280 : 854;
    qualityConfig.fps = fps;
    qualityConfig.bitrateBps = bps;
    qualityConfig.contentHint = hint;

    let modeTitle = 'Personalizado';
    if (currentMode === 'default') modeTitle = 'Padrão (1080p60)';
    else if (currentMode === 'jogo') modeTitle = 'Modo Jogo (60FPS)';
    else if (currentMode === 'filme') modeTitle = 'Modo Filme (30FPS)';

    elements.labelCurrentQuality.textContent = `Modo: ${modeTitle}`;
    elements.qualityStats.textContent = `${modeTitle}: ${h}p @ ${fps}FPS`;

    closeQualityModal();

    if (isSharing && localStream) {
        applyDynamicWebRTCBitrate(bps);
        applyContentHint(hint);
        showToast(`Modo [${modeTitle}] aplicado! Bitrate: ${(bps / 1000000).toFixed(1)} Mbps.`);
    } else {
        showToast(`Modo [${modeTitle}] selecionado! Será aplicado ao iniciar o compartilhamento.`);
    }
}

// Real-Time Web Audio Visualizer Meter
let _audioMeterSource = null;

function setupAudioMeter(stream) {
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }

        // Evita acumular nós de áudio a cada reconexão (causava travamento)
        if (_audioMeterSource) {
            try { _audioMeterSource.disconnect(); } catch (e) {}
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
            if (!isSharing) return;
            audioAnalyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length;
            const percent = Math.min(100, Math.round((average / 128) * 100));
            elements.audioMeterBar.style.width = `${percent}%`;
            audioAnimFrame = requestAnimationFrame(renderMeter);
        }
        renderMeter();
    } catch (err) {
        console.warn('Não foi possível inicializar o medidor de áudio:', err);
    }
}
