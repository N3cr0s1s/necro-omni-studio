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
export * from './relink.js';
export * from './drag-target.js';
export * from './roll-edit.js';
export * from './frame-grab.js';
export * from './insert-generated.js';
export * from './transition-ops.js';
export * from './import-media.js';
export * from './range-ops.js';
export * from './track-ops.js';
export * from './unused-takes.js';
export * from './clipboard.js';
export * from './selection.js';
export * from './move-many.js';
export * from './project-settings.js';
export * from './attributes.js';
export * from './linking.js';
export * from './clip-transform.js';
export * from './story-ops.js';
export * from './clip-speed.js';
export * from './trim-group.js';
export * from './fade-ops.js';
export * from './move-crossfade.js';
export * from './close-gap.js';
