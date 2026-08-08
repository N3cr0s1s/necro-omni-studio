/**
 * Media contracts.
 *
 * Types and interfaces only — no implementation. The sidecar client, the fakes used in tests
 * and any future backend all bind to these, so nothing above this layer knows that ffmpeg or
 * a Python process exists.
 */
export * from './media-kind.js';
export * from './probe.js';
export * from './derived.js';
export * from './watcher.js';
