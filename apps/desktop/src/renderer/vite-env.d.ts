import type { DesktopSource } from '../preload/preload';

declare global {
  interface Window {
    partilharTela: {
      getSources: () => Promise<DesktopSource[]>;
      setCaptureSource: (sourceId: string) => Promise<void>;
      copyText: (text: string) => Promise<void>;
    };
  }
}

export {};
