/**
 * `@nos/editing` — timeline editing operations.
 *
 * Pure `TimelineDocument -> Result<TimelineDocument, EditError>` transforms. No I/O, no UI, no
 * mutation. Composed inside a `store.transaction()` so a whole gesture becomes one undo step.
 */
export * from './errors.js';
export * from './snap.js';
export * from './mutate.js';
export * from './clip-ops.js';
export * from './insert-generated.js';
export * from './transition-ops.js';
export * from './import-media.js';
export * from './range-ops.js';
