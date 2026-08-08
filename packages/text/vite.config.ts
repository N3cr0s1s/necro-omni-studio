import { defineConfig } from 'vite';

/** Dev-only config for the rasterizer verification harness. */
export default defineConfig({
  root: 'rastercheck',
  server: { port: 5201, strictPort: true },
});
