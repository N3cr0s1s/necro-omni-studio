import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration.
 *
 * Tests live next to the code they cover (`*.test.ts`). Packages that need a DOM
 * (compositor, ui) opt in per-file with a `// @vitest-environment jsdom` pragma so
 * the default node environment stays fast for the bulk of the suite.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'apps/desktop/src/**/*.test.ts',
      'apps/desktop/src/**/*.test.tsx',
    ],
    environment: 'node',
    // A DOM gap rather than a preference: Base UI constructs a `PointerEvent`, which jsdom does not
    // implement. The file is a no-op outside a DOM environment.
    setupFiles: ['./test/jsdom-pointer-events.ts'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/contracts/**'],
    },
  },
});
