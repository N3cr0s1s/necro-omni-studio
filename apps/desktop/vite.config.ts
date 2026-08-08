import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Renderer bundling.
 *
 * Only the renderer: the main and preload processes are plain Node/CommonJS and are compiled by
 * `tsc`, because bundling them buys nothing and makes a stack trace from the main process
 * unreadable.
 */
export default defineConfig({
  root: '.',
  base: './',
  build: { outDir: 'dist/renderer', emptyOutDir: true },
  plugins: [react()],
  server: { port: 5198, strictPort: true },
});
