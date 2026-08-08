import { defineConfig } from 'vite';

/** Dev-only config for the GL verification harness. */
export default defineConfig({
  root: 'glcheck',
  server: { port: 5200, strictPort: true },
});
