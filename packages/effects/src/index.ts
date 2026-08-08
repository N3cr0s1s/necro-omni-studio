/**
 * `@nos/effects` — effect and transition manifests.
 *
 * The registry implements the compositor's `EffectSourceResolver`, so it slots in behind that interface
 * with no change to the render path. No specific effect appears in the render code: an effect is a GLSL
 * file plus a manifest, and adding one is a file drop.
 */
export * from './manifest/effect-manifest.js';
export * from './registry/effect-registry.js';
export * from './builtin/builtin-effects.js';
