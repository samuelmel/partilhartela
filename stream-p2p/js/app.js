/**
 * StreamP2P - Main Application Entry Point
 */

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize DOM references in UI module
    initDOMElements();

    // 2. Refresh Lucide Icons
    refreshIcons();

    // 3. Show Firefox Notice if Firefox is detected
    if (isFirefox) {
        if (elements.firefoxLandingNotice) elements.firefoxLandingNotice.classList.remove('hidden');
    }

    // 4. URL Router Logic (check ?sala= parameter)
    const urlParams = new URLSearchParams(window.location.search);
    const salaParam = urlParams.get('sala');

    if (salaParam && salaParam.trim() !== '') {
        roomId = salaParam.trim();
        initRoomView(roomId);
    } else {
        initLandingView();
    }
});

// Initialize Landing Page View & Form Handlers
function initLandingView() {
    elements.landingView.classList.remove('hidden');
    elements.roomView.classList.add('hidden');

    elements.btnCreateRoom.addEventListener('click', () => {
        const newRoomId = typeof crypto.randomUUID === 'function' 
            ? crypto.randomUUID().slice(0, 8) 
            : Math.random().toString(36).substring(2, 10);
        
        window.location.href = `index.html?sala=${newRoomId}`;
    });

    elements.joinRoomForm.addEventListener('submit', (e) => {
        e.preventDefault();
        let code = elements.inputRoomCode.value.trim();
        if (!code) return;

        if (code.includes('?sala=')) {
            const match = code.match(/\?sala=([^&]+)/);
            if (match) code = match[1];
        }

        window.location.href = `index.html?sala=${encodeURIComponent(code)}`;
    });
}

// Initialize Room View & Toolbar Event Listeners
function initRoomView(targetRoomId) {
    elements.landingView.classList.add('hidden');
    elements.roomView.classList.remove('hidden');
    elements.roomView.classList.add('flex');

    if (isFirefox) {
        if (elements.firefoxRoomNotice) elements.firefoxRoomNotice.classList.remove('hidden');
    }

    elements.displayRoomId.textContent = targetRoomId;

    // Se estiver no aplicativo Electron, gera o link web apontando para o Render
    const isApp = window.electronAPI && window.electronAPI.isElectron;
    const shareUrl = isApp 
        ? `${WEB_APP_URL}/index.html?sala=${encodeURIComponent(targetRoomId)}`
        : window.location.href;

    elements.shareUrlInput.value = shareUrl;

    // 1-Click Copy Link Handler
    elements.btnCopyLink.addEventListener('click', () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
            elements.copyBtnText.textContent = 'Copiado!';
            elements.btnCopyLink.classList.replace('bg-brand-600', 'bg-emerald-600');
            showToast('Link web da sala copiado! Seu amigo pode abrir direto no navegador.');
            setTimeout(() => {
                elements.copyBtnText.textContent = 'Copiar Link';
                elements.btnCopyLink.classList.replace('bg-emerald-600', 'bg-brand-600');
            }, 2500);
        }).catch(() => {
            elements.shareUrlInput.select();
            document.execCommand('copy');
            showToast('Link selecionado! Use Ctrl+C para copiar.');
        });
    });

    // Fullscreen Toggle Handler
    elements.btnFullscreen.addEventListener('click', () => {
        const stageContainer = elements.remoteVideo.parentElement;
        if (!document.fullscreenElement) {
            stageContainer.requestFullscreen().catch(err => {
                showToast(`Erro ao ativar tela cheia: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    });

    // Discord Selective Audio Modal Handlers
    elements.btnDiscordGuide.addEventListener('click', () => elements.discordGuideModal.classList.remove('hidden'));
    elements.btnCloseDiscordGuide.addEventListener('click', () => elements.discordGuideModal.classList.add('hidden'));
    elements.btnGotItDiscord.addEventListener('click', () => elements.discordGuideModal.classList.add('hidden'));

    // Quality Modal Handlers
    elements.btnQualityModal.addEventListener('click', openQualityModal);
    elements.qualityBadge.addEventListener('click', openQualityModal);
    elements.btnCloseQualityModal.addEventListener('click', closeQualityModal);
    elements.btnCancelQualityModal.addEventListener('click', closeQualityModal);
    elements.btnApplyQualityModal.addEventListener('click', applyQualitySettingsFromModal);

    // Microphone Handler
    elements.btnToggleMic.addEventListener('click', toggleMicrophoneCapture);

    // Initialize WebRTC P2P Peer Connection
    setupPeerJS(targetRoomId);
}
