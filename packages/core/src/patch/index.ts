/**
 * Mutation layer.
 *
 * The document is immutable; this layer owns the only path that produces a new one, plus
 * the undo history, dirty tracking and autosave policy built on top of it.
 */
export * from './history.js';
export * from './store.js';
export * from './autosave.js';
