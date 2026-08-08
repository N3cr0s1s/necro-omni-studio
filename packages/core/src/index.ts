/**
 * `@nos/core` — the domain foundation.
 *
 * Pure: no I/O, no DOM, no Electron. Everything above (compositor, generators,
 * backends, UI, sidecar clients) depends on this package, and this package depends on
 * nothing but the language.
 */
export * from './lang/brand.js';
export * from './lang/numbers.js';
export * from './lang/result.js';
export * from './lang/validate.js';
export * from './time/index.js';
export * from './document/index.js';
export * from './patch/index.js';
export * from './serialization/index.js';
