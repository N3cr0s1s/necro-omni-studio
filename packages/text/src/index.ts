/**
 * `@nos/text` — the text layer.
 *
 * Animation presets are pure keyframe *generators*: applying one writes real, editable keyframes, and
 * nothing consults a preset at render time. The spec requires that there be no hidden animation.
 */
export * from './contracts/index.js';
export * from './raster/typewriter.js';
export * from './animation/presets.js';
