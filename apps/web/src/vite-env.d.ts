/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TOKEN_SERVER_URL?: string;
  /** Destino do botão "Baixar para Windows"; padrão: Releases do GitHub. */
  readonly VITE_DOWNLOAD_URL?: string;
}
