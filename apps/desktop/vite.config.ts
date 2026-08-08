import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Renderer bundling.
 *
 * Only the renderer: the main and preload processes are plain Node/CommonJS and are compiled by
 * `tsc`, because bundling them buys nothing and makes a stack trace from the main process
 * unreadable.
 *
 * Tailwind runs as a Vite plugin rather than through PostCSS — that is what shadcn's own Vite
 * template does, and it means the single `@import "tailwindcss"` in `@nos/ui/globals.css` is the
 * whole configuration. The class names it compiles live in two workspaces, and the `@source` lines
 * in that file are what let it find the ones under `packages/ui`.
 */
export default defineConfig({
  root: '.',
  base: './',
  build: { outDir: 'dist/renderer', emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  server: { port: 5198, strictPort: true },
});
