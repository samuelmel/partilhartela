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
      /** Código de sala recebido por partilhartela://join/CODIGO enquanto o app abria. */
      consumePendingJoin: () => Promise<string | null>;
      /** Avisa que chegou um link de sala; leia o código com consumePendingJoin. */
      onJoinRequest: (listener: () => void) => () => void;
      /** Abre o login do Discord no navegador (PKCE) e devolve o code para trocar no servidor. */
      authorizeDiscord: (clientId: string) => Promise<{ code: string; codeVerifier: string; redirectUri: string }>;
      /** Sessão do Discord cifrada com safeStorage no perfil do usuário. */
      saveSession: (value: string) => Promise<void>;
      loadSession: () => Promise<string | null>;
      clearSession: () => Promise<void>;
    };
  }
}

export {};
