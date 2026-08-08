/**
 * `@nos/generators` — the generator framework.
 *
 * The spec's most important architectural element: the application knows no model, graph, node class or
 * generator. Every generative capability attaches through a manifest, and adding one is a JSON file.
 */
export * from './contracts/index.js';
export * from './manifest/graph-pointer.js';
export * from './manifest/manifest-draft.js';
export * from './registry/generator-registry.js';
export * from './queue/variant-plan.js';
export * from './queue/gpu-semaphore.js';
export * from './queue/job-queue.js';
export * from './staging/placeholder.js';
export * from './staging/variant-selection.js';
export * from './backends/mock-backend.js';
