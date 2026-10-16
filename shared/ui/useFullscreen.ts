import { useCallback, useEffect, useState, type RefObject } from 'react';

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
};

function fullscreenElement(): Element | null {
  const doc = document as WebkitDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function exitFullscreen(): Promise<void> {
  const doc = document as WebkitDocument;
  if (doc.exitFullscreen) await doc.exitFullscreen();
  else await doc.webkitExitFullscreen?.();
}

/**
 * Tela cheia do container do palco. O estado vem dos eventos reais
 * (`fullscreenchange`, inclusive saída por Esc), nunca do último clique.
 * iPhone não tem Fullscreen API em elementos: cai para o player nativo do <video>.
 */
export function useFullscreen(containerRef: RefObject<HTMLElement>, videoRef: RefObject<HTMLVideoElement>) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const video = videoRef.current as WebkitVideo | null;
    const sync = () => {
      const container = containerRef.current;
      setActive(Boolean(container && fullscreenElement() === container) || Boolean(video?.webkitDisplayingFullscreen));
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    video?.addEventListener('webkitbeginfullscreen', sync);
    video?.addEventListener('webkitendfullscreen', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
      video?.removeEventListener('webkitbeginfullscreen', sync);
      video?.removeEventListener('webkitendfullscreen', sync);
    };
  }, [containerRef, videoRef]);

  const toggle = useCallback(async () => {
    setError('');
    const container = containerRef.current as WebkitElement | null;
    if (!container) return;
    try {
      if (fullscreenElement()) {
        await exitFullscreen();
        return;
      }
      if (typeof container.requestFullscreen === 'function') {
        await container.requestFullscreen({ navigationUI: 'hide' });
        return;
      }
      if (typeof container.webkitRequestFullscreen === 'function') {
        await container.webkitRequestFullscreen();
        return;
      }
      const video = videoRef.current as WebkitVideo | null;
      if (typeof video?.webkitEnterFullscreen === 'function') {
        video.webkitEnterFullscreen();
        return;
      }
      setError('Este navegador não oferece tela cheia.');
    } catch (reason) {
      console.warn('[PartilharTela] Tela cheia recusada:', reason);
      setError('A tela cheia foi recusada. Clique no botão de novo.');
    }
  }, [containerRef, videoRef]);

  return { active, toggle, error };
}

/** Sai da tela cheia, se houver, antes de desmontar a sala. */
export async function leaveFullscreen(): Promise<void> {
  if (!fullscreenElement()) return;
  try {
    await exitFullscreen();
  } catch {
    // O elemento será removido do DOM de qualquer forma, o que também encerra a tela cheia.
  }
}
