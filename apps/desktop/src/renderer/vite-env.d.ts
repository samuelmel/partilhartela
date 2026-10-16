import type { DesktopSource } from '../preload/preload';

declare global {
  interface ImportMetaEnv {
    readonly VITE_TOKEN_SERVER_URL?: string;
    /** URL pública do viewer web; quando definida, "Copiar" gera link ?room=CODIGO em vez de só o código. */
    readonly VITE_WEB_APP_URL?: string;
  }

  interface Window {
    partilharTela: {
      getSources: () => Promise<DesktopSource[]>;
      getAudioProcesses: () => Promise<Array<{ title: string; processId: string }>>;
      setCaptureSource: (sourceId: string) => Promise<void>;
      copyText: (text: string) => Promise<void>;
      startApplicationAudio: (processId: string) => Promise<void>;
      startSystemAudioExcluding: (processId: string) => Promise<void>;
      stopApplicationAudio: () => Promise<void>;
      onAudioData: (listener: (chunk: Uint8Array) => void) => () => void;
    };
  }
}

export {};
