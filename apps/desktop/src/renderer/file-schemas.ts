import type { SchemaShape } from '@nos/core';
import { EFFECT_MANIFEST_SCHEMA } from '@nos/effects';
import { GENERATOR_MANIFEST_SCHEMA } from '@nos/generators';

/**
 * Which description applies to which file — issue #31.
 *
 * A registry rather than a switch, because the point of the feature is that the *next* kind of file
 * someone wants to edit is an entry here. Nothing in the editor or the completion engine learns about
 * a new one: the editor asks this for a shape and gets `undefined` for anything unmodelled, which is
 * the same path a `.txt` takes.
 *
 * Matching is on the project-relative path, so it follows §4's folder layout: `generators/` holds
 * generator manifests, `effects/` holds effect and transition manifests. Matching on file *contents*
 * — sniffing for a `category` field, say — was the alternative and is worse: a file being written from
 * scratch has no fields yet, which is precisely when completion is wanted most.
 */

export interface FileSchema {
  /** Named so a mismatch can be reported as "this was treated as X", rather than as silence. */
  readonly id: string;
  readonly matches: (path: string) => boolean;
  readonly shape: SchemaShape;
}

/** Case-insensitively under a folder, on either separator — the path comes from the OS. */
function under(folder: string, extension: string): (path: string) => boolean {
  return (path) => {
    const normalized = path.replace(/\\/gu, '/').toLowerCase();
    return normalized.startsWith(`${folder}/`) && normalized.endsWith(extension);
  };
}

export const FILE_SCHEMAS: readonly FileSchema[] = [
  {
    id: 'generator-manifest',
    // Graphs live in the same folder and are ComfyUI's format, not this application's — describing
    // them here would offer manifest fields inside a graph, confidently and wrongly.
    matches: (path) => under('generators', '.json')(path) && !under('generators', '.graph.json')(path),
    shape: GENERATOR_MANIFEST_SCHEMA,
  },
  {
    id: 'effect-manifest',
    matches: under('effects', '.json'),
    shape: EFFECT_MANIFEST_SCHEMA,
  },
];

/** The description for a path, or `undefined` where nothing claims it. */
export function schemaFor(
  path: string,
  registry: readonly FileSchema[] = FILE_SCHEMAS,
): FileSchema | undefined {
  return registry.find((entry) => entry.matches(path));
}
