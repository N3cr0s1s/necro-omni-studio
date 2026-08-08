/**
 * `@nos/masks` — the SAM 2 pipeline's engine-agnostic half.
 *
 * The spec's rule: a mask is an asset type like any other, and reaches an effect through a declared
 * `mask` sampler slot. Nothing here knows what SAM 2 is; the engine is an interface.
 */
export * from './contracts/index.js';
export * from './codec/rle.js';
export * from './cache/mask-cache.js';
export * from './session/mask-session.js';
