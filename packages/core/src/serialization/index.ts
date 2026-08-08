/**
 * Serialization layer.
 *
 * The only place that knows both the in-memory shape and the `project.json` shape. The
 * two differ on purpose: memory optimizes for the render loop, the file optimizes for
 * being read, diffed and hand-edited by a human.
 */
export * from './document-schema.js';
export * from './serialize.js';
export * from './migrate.js';
export * from './project-file.js';
