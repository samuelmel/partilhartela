/**
 * StreamP2P Web - Ponto de entrada do renderer.
 *
 * Diferenca para o Desktop: o link compartilhado e o proprio `location.href`,
 * porque quem assiste ja esta no navegador.
 */

'use strict';

document.addEventListener('DOMContentLoaded', () => {
  initDOMElements();
  refreshIcons();

  if (isFirefox && elements.firefoxLandingNotice) {
    elements.firefoxLandingNotice.classList.remove('hidden');
  }

  const params = new URLSearchParams(window.location.search);
  const salaParam = params.get('sala');

  if (salaParam && salaParam.trim() !== '') {
    initRoomView(salaParam.trim());
  } else {
    initLandingView();
  }
});

function initLandingView() {
  elements.landingView.classList.remove('hidden');
  elements.roomView.classList.add('hidden');

  elements.btnCreateRoom.addEventListener('click', () => {
    const Signaling = window.StreamP2P ? window.StreamP2P.Signaling : null;
    const newRoomId = Signaling
      ? Signaling.generateRoomId()
      : Math.random().toString(36).substring(2, 10);

    window.location.href = 'index.html?sala=' + newRoomId;
  });

  elements.joinRoomForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const Signaling = window.StreamP2P ? window.StreamP2P.Signaling : null;
    const raw = elements.inputRoomCode.value.trim();
    if (!raw) return;

    const code = Signaling ? Signaling.parseRoomCode(raw) : raw;
    if (!code) {
      showToast('Codigo de sala invalido.');
      return;
    }

    window.location.href = 'index.html?sala=' + encodeURIComponent(code);
  });
}

function initRoomView(targetRoomId) {
  elements.landingView.classList.add('hidden');
  elements.roomView.classList.remove('hidden');
  elements.roomView.classList.add('flex');

  if (isFirefox && elements.firefoxRoomNotice) {
    elements.firefoxRoomNotice.classList.remove('hidden');
  }

  elements.displayRoomId.textContent = targetRoomId;

  // No web, o link ja e a URL atual: nao ha build desktop para compartilhar.
  const shareUrl = window.location.href;
  elements.shareUrlInput.value = shareUrl;

  elements.btnCopyLink.addEventListener('click', () => {
    const done = () => {
      elements.copyBtnText.textContent = 'Copiado!';
      elements.btnCopyLink.classList.replace('bg-brand-600', 'bg-emerald-600');
      showToast('Link da sala copiado!');
      setTimeout(() => {
        elements.copyBtnText.textContent = 'Copiar Link';
        elements.btnCopyLink.classList.replace('bg-emerald-600', 'bg-brand-600');
      }, 2500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl).then(done).catch(() => {
        elements.shareUrlInput.select();
        document.execCommand('copy');
        showToast('Link selecionado! Use Ctrl+C para copiar.');
      });
    } else {
      elements.shareUrlInput.select();
      document.execCommand('copy');
      showToast('Link selecionado! Use Ctrl+C para copiar.');
    }
  });

  elements.btnFullscreen.addEventListener('click', () => {
    const target = getSelectedStreamVideo();
    if (!document.fullscreenElement) {
      target.requestFullscreen().catch((err) => {
        showToast('Erro ao ativar tela cheia: ' + err.message);
      });
    } else {
      document.exitFullscreen();
    }
  });

  elements.btnDiscordGuide.addEventListener('click', () =>
    elements.discordGuideModal.classList.remove('hidden'));
  elements.btnCloseDiscordGuide.addEventListener('click', () =>
    elements.discordGuideModal.classList.add('hidden'));
  elements.btnGotItDiscord.addEventListener('click', () =>
    elements.discordGuideModal.classList.add('hidden'));

  elements.btnQualityModal.addEventListener('click', openQualityModal);
  elements.qualityBadge.addEventListener('click', openQualityModal);
  elements.btnCloseQualityModal.addEventListener('click', closeQualityModal);
  elements.btnCancelQualityModal.addEventListener('click', closeQualityModal);
  elements.btnApplyQualityModal.addEventListener('click', applyQualitySettingsFromModal);

  setupPeerJS(targetRoomId);
}