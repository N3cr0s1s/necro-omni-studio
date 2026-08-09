/**
 * Document layer.
 *
 * Immutable data only: no methods on the entities, no identity beyond ids, no I/O. All
 * mutation happens in the patch layer, which keeps undo/redo and autosave uniform.
 */
export * from './ids.js';
export * from './asset-type.js';
export * from './params.js';
export * from './keyframe-edits.js';
export * from './clip.js';
export * from './track.js';
export * from './document.js';
export * from './story.js';
