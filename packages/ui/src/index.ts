/**
 * `@nos/ui` — the application's panels.
 *
 * Presentational only: components take data and callbacks, and hold no application state beyond
 * local interaction state (which tree rows are expanded, which field has focus). Everything that
 * outlives a render lives in the document store, so undo and autosave see it.
 *
 * The shadcn registry is deliberately **not** re-exported here. It is reached at its own path —
 * `@nos/ui/components/ui/button` — which is the import shadcn's own documentation shows, so a snippet
 * from the registry can be pasted into this repository and work. A barrel over it would also make
 * every panel depend on every component in the library.
 */
export * from './semantics/glyphs.js';
export * from './menus/ActionMenu.js';
export * from './controls/NumberField.js';
export * from './notes/NoteView.js';
export * from './status/activity.js';
export * from './status/StatusBar.js';
export * from './media-browser/MediaBrowser.js';
export * from './media-browser/AssetIcon.js';
export * from './timeline/index.js';
export * from './transport/index.js';
export * from './inspector/index.js';
export * from './export/index.js';
export * from './generators/index.js';
export * from './staging/index.js';
export * from './segmentation/index.js';
