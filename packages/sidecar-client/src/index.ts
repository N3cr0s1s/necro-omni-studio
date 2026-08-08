/**
 * `@nos/sidecar-client` — the sidecar-backed implementation of the `@nos/media` contracts.
 *
 * The only package that knows the sidecar's HTTP API exists. Swapping it for a different media
 * backend means providing another `MediaProber`/`DerivedArtifactService` pair; no consumer changes.
 */
export * from './transport.js';
export * from './peaks-codec.js';
export * from './media-client.js';
