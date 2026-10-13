import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  envDir: '../..',
  base: './',
  plugins: [react()],
  server: { strictPort: true, port: 5173 },
  build: { outDir: '../../dist', emptyOutDir: true }
});
