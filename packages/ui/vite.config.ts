import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Dev-only config for the visual harness. The library itself ships as TypeScript sources. */
export default defineConfig({
  root: 'harness',
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});
