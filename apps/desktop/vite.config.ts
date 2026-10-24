import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// CSP só no build: o servidor de dev do Vite injeta script inline (React Refresh).
// connect-src aceita https/wss porque a URL do LiveKit vem do servidor de tokens em tempo de execução.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://cdn.discordapp.com",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'partilhartela-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy }, injectTo: 'head-prepend' }
    ]
  };
}

export default defineConfig({
  root: 'src/renderer',
  envDir: '../..',
  base: './',
  plugins: [react(), cspPlugin()],
  server: { strictPort: true, port: 5173 },
  build: { outDir: '../../dist', emptyOutDir: true }
});
