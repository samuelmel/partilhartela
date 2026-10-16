export type CaptureSupport = { ok: true; audio: boolean } | { ok: false; reason: string };
export type Notice = { tone: 'ok' | 'warn' | 'error' | 'info'; text: string };

type NavigatorWithBrands = Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } };

// Só navegadores Chromium entregam áudio pelo getDisplayMedia (aba; no Windows, também o sistema).
function isChromium(): boolean {
  const brands = (navigator as NavigatorWithBrands).userAgentData?.brands;
  if (brands) return brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(brand));
  return /Chrome\/|Edg\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
}

function isMobile(): boolean {
  const ua = navigator.userAgent;
  // iPadOS se apresenta como Mac, mas tem toque.
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function detectCaptureSupport(): CaptureSupport {
  if (isMobile()) {
    return { ok: false, reason: 'Celulares e tablets não transmitem a tela pelo navegador. Daqui você assiste normalmente; para transmitir, use um computador.' };
  }
  if (!window.isSecureContext) {
    return { ok: false, reason: 'Transmitir exige conexão segura. Abra o site por um endereço https.' };
  }
  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    return { ok: false, reason: 'Este navegador não permite transmitir a tela. Use Chrome, Edge ou Firefox atualizados.' };
  }
  return { ok: true, audio: isChromium() };
}

export function describeCaptureError(error: unknown): Notice {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';

  switch (name) {
    case 'NotAllowedError':
      if (/system/i.test(message)) {
        return { tone: 'error', text: 'O sistema bloqueou a captura de tela. No macOS, libere o navegador em Ajustes do Sistema > Privacidade e Segurança > Gravação de Tela.' };
      }
      return { tone: 'info', text: 'Compartilhamento cancelado, nada foi transmitido. Se você não cancelou, confira se o navegador bloqueou a captura nas permissões do site.' };
    case 'NotReadableError':
    case 'AbortError':
      return { tone: 'error', text: 'O navegador não conseguiu ler a fonte escolhida. Tente outra tela ou janela.' };
    case 'NotFoundError':
      return { tone: 'error', text: 'Nenhuma tela ou janela disponível para capturar.' };
    case 'NotSupportedError':
    case 'DeviceUnsupportedError':
      return { tone: 'error', text: 'Este navegador não permite transmitir a tela.' };
    default:
      return { tone: 'error', text: `A transmissão não foi publicada${message ? ` (${message})` : ''}. Tente de novo.` };
  }
}
