/**
 * JSON as a language the editor understands: where a caret is, what may go there, per issue #31.
 *
 * Here rather than in `@nos/ui` because the descriptions of the shipped manifests live beside the
 * types they describe — in `@nos/generators` and `@nos/effects` — and neither may depend on the
 * interface package. The colouring stays in `@nos/ui`, which is where painting belongs.
 */
export * from './json-location.js';
export * from './schema.js';
export * from './completion.js';
