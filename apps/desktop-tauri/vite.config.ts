import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Mesmo .env do app desktop (VITE_TOKEN_SERVER_URL): o valor fica só nos arquivos .env, nunca no código.
  envDir: '../desktop',
  clearScreen: false,
  build: { outDir: 'dist', target: 'chrome105' },
  server: { port: 5175, strictPort: true }
});
