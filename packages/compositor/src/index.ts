/**
 * `@nos/compositor` — the render pipeline.
 *
 * The plan builder and the shader assembler are pure and testable without a GL context; the executor
 * consuming them is the only part that needs one. Preview and export both build the same plan from the
 * same document, which is what makes the spec's WYSIWYG guarantee structural rather than aspirational.
 */
export * from './contracts/index.js';
export * from './plan/build-plan.js';
export * from './shader/shader-source.js';
export * from './gl/index.js';
