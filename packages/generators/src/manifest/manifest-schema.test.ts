import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type SchemaShape, shapeAt } from '@nos/core';
import { GENERATOR_MANIFEST_SCHEMA } from './manifest-schema.js';

/**
 * The completion description, checked against the manifests this project actually ships.
 *
 * The `Record<keyof GeneratorManifest, …>` in the description makes the compiler prove that every
 * field of the *type* is described. It cannot prove the reverse — that every name the description
 * offers is one the files really use, or that a field appearing on disk is one the description knows.
 * Those are the failures that matter here: a completion list is trusted, so a name that is merely
 * plausible is worse than a missing one.
 *
 * The five files in `generators/` are the ground truth, the same way the round-trip check beside this
 * one uses them. Walking them finds drift the type system is blind to — including the whole class of
 * bug where the on-disk spelling and the in-memory one diverge.
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const shipped = readdirSync(`${repoRoot}/generators`).filter((name) => name.endsWith('.manifest.json'));

/** Every path in a document that leads to an object key, as `['params', 0, 'key']`. */
function keyPaths(value: unknown, path: readonly (string | number)[] = []): (readonly (string | number)[])[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => keyPaths(entry, [...path, index]));
  if (typeof value !== 'object' || value === null) return [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
    [...path, key],
    ...keyPaths(nested, [...path, key]),
  ]);
}

/** Whether the description models the container a path sits in — an unmodelled one describes nothing. */
function describedContainer(shape: SchemaShape, path: readonly (string | number)[]): boolean {
  const container = shapeAt(shape, path.slice(0, -1));
  return container !== undefined && container.kind === 'object';
}

describe('the description of a generator manifest', () => {
  it('has files to check itself against', () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  for (const name of shipped) {
    describe(name, () => {
      const document: unknown = JSON.parse(readFileSync(`${repoRoot}/generators/${name}`, 'utf8'));

      it('describes every field the file actually uses', () => {
        /*
         * Only where the description claims to model the container. `params[].options` may be a live
         * capability source whose inner keys are deliberately `unknown`, and demanding names for those
         * would be demanding that this file mirror ComfyUI's graph format — which is exactly the thing
         * the `unknown` shape exists to decline.
         */
        const missing = keyPaths(document)
          .filter((path) => typeof path[path.length - 1] === 'string')
          .filter((path) => describedContainer(GENERATOR_MANIFEST_SCHEMA, path))
          .filter((path) => shapeAt(GENERATOR_MANIFEST_SCHEMA, path) === undefined)
          .map((path) => path.join('.'));

        expect(missing).toEqual([]);
      });

      it('offers only values the file’s own constrained fields agree with', () => {
        // A `oneOf` that is missing a value the shipped manifests use is a description that would
        // silently mark a correct file as unusual — and would never suggest the value that is right.
        const wrong = keyPaths(document)
          .filter((path) => describedContainer(GENERATOR_MANIFEST_SCHEMA, path))
          .map((path) => ({
            path,
            shape: shapeAt(GENERATOR_MANIFEST_SCHEMA, path),
            value: valueAt(document, path),
          }))
          .filter((entry) => entry.shape?.kind === 'string' && entry.shape.values !== undefined)
          .filter((entry) => typeof entry.value === 'string')
          .filter((entry) => {
            const shape = entry.shape as { readonly values: readonly string[] };
            return !shape.values.includes(entry.value as string);
          })
          .map((entry) => `${entry.path.join('.')} = ${String(entry.value)}`);

        expect(wrong).toEqual([]);
      });
    });
  }
});

function valueAt(document: unknown, path: readonly (string | number)[]): unknown {
  let value: unknown = document;
  for (const step of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string | number, unknown>)[step];
  }
  return value;
}
