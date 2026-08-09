import { describe, expect, it } from 'vitest';
import { type SchemaShape, shapeAt } from '@nos/core';
import { EFFECT_MANIFEST_SCHEMA } from './effect-schema.js';
import { effectManifestJson, emptyEffectDraft } from './effect-draft.js';

/**
 * The completion description, checked against what the application itself writes.
 *
 * `effectManifestJson` is the authoritative on-disk writer — it is what the effect editor saves, so
 * anything it emits is by definition a field a user will see in the file. A description that does not
 * know one of those names is a description that will not complete the file the editor just produced,
 * which is the most likely thing anyone ever opens.
 *
 * This is the check the `Record<keyof T, …>` cannot make: the compiler proves nothing is *missing*
 * from the description, and this proves the names in it are the file's rather than the model's.
 */

/** Every path in a document that leads to an object key. */
function keyPaths(value: unknown, path: readonly (string | number)[] = []): (readonly (string | number)[])[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => keyPaths(entry, [...path, index]));
  if (typeof value !== 'object' || value === null) return [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
    [...path, key],
    ...keyPaths(nested, [...path, key]),
  ]);
}

function undescribed(document: unknown, shape: SchemaShape): readonly string[] {
  return keyPaths(document)
    .filter((path) => typeof path[path.length - 1] === 'string')
    .filter((path) => {
      const container = shapeAt(shape, path.slice(0, -1));
      return container !== undefined && container.kind === 'object';
    })
    .filter((path) => shapeAt(shape, path) === undefined)
    .map((path) => path.join('.'));
}

describe('the description of an effect manifest', () => {
  it('knows every field a new effect is saved with', () => {
    const written = effectManifestJson(emptyEffectDraft());
    expect(undescribed(written, EFFECT_MANIFEST_SCHEMA)).toEqual([]);
  });

  it('knows every field a fully-filled effect is saved with', () => {
    // The empty draft omits everything optional, so on its own it would prove very little.
    const draft = {
      ...emptyEffectDraft(),
      id: 'film_grain',
      name: 'Film grain',
      group: 'Texture',
      description: 'Adds grain.',
      samplers: ['source', 'mask'],
      params: [
        {
          id: 'p1',
          key: 'amount',
          uniform: 'uAmount',
          type: 'float' as const,
          label: 'Amount',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5,
        },
      ],
    };
    expect(undescribed(effectManifestJson(draft), EFFECT_MANIFEST_SCHEMA)).toEqual([]);
  });

  it('offers the file’s spelling of the transition progress uniform, not the model’s', () => {
    // `normalizeManifestKeys` translates `progress_uniform` on the way in. Suggesting `progressUniform`
    // would write a field the loader drops without a word.
    expect(shapeAt(EFFECT_MANIFEST_SCHEMA, ['progress_uniform'])).toBeDefined();
    expect(shapeAt(EFFECT_MANIFEST_SCHEMA, ['progressUniform'])).toBeUndefined();
  });

  it('describes both categories, so a manifest completes before its category line is typed', () => {
    // The `category` line is frequently the last thing written, and a list that stayed empty until it
    // existed would be useless exactly when a new manifest is being started.
    expect(shapeAt(EFFECT_MANIFEST_SCHEMA, ['convention'])).toBeDefined();
    expect(shapeAt(EFFECT_MANIFEST_SCHEMA, ['samplers'])).toBeDefined();
  });
});
