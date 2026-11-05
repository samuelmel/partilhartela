/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TOKEN_SERVER_URL?: string;
  /** Base da versão web usada nos convites; sem ela o copiar entrega só o código. */
  readonly VITE_WEB_APP_URL?: string;
}
