import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { saveDocument } from './project-file.js';
import { richDocument } from './rich-document.js';

/**
 * Every field of the document model reaches the file.
 *
 * `project-file.test.ts` already round-trips a rich document and compares it to what went in. That
 * catches a serializer that mangles a field — and it is completely blind to a field the *fixture*
 * never sets. Add `track.collapsed` to the model, forget it in both the serializer and the fixture,
 * and the round trip keeps passing while the value is silently dropped from every project ever saved.
 *
 * This is the other half. It reads the property names out of the document model's own source, saves
 * the rich fixture, and asserts each name appears somewhere in the JSON. A field that is missing is
 * either not serialized or not exercised, and both are the same bug from a user's chair: the setting
 * they made does not survive closing the project.
 *
 * ## Why a default is not enough
 *
 * The serializer omits anything equal to its default, which keeps a project file readable. The
 * consequence is that a flag written only at its default never appears in the JSON at all — so it
 * proves nothing, and this check will say so. That is how `track.muted` turned out to be the one
 * track flag the fixture had never set to `true`.
 *
 * ## Why the exemptions name interfaces
 *
 * Three things in `document/` are not document state: a computed render structure, an argument object
 * and a query result. Exempting them by *interface* rather than by field name is deliberate — a
 * field-name exemption silently covers any future field that happens to share the name, which is
 * exactly how an exemption list stops being trustworthy.
 */

/**
 * Types under `document/` that are not part of a saved project.
 *
 * Kept short on purpose. Anything added here needs a reason in this comment, because every entry is
 * a piece of the model this check no longer looks at.
 */
const NOT_DOCUMENT_STATE: ReadonlySet<string> = new Set([
  // The three numbers a typewriter reveal is cut at. Computed per frame from the clip's animation;
  // storing it would be storing a render.
  'TypewriterCut',
  // The arguments `createDocument` takes. It describes how to build a document, not what one holds.
  'CreateDocumentOptions',
  // The empty runs between a track's clips. Derived from where the clips are, and stored nowhere — a
  // gap has no existence beyond the two clips that bound it, which is exactly why the timeline has to
  // compute one to draw it.
  'TrackGap',
]);

/** Every `readonly` property declared by a document interface, minus the exempt ones. */
function declaredFields(): ReadonlyMap<string, string> {
  const dir = new URL('../document/', import.meta.url).pathname;
  const fields = new Map<string, string>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const source = readFileSync(dir + file, 'utf8');

    // Each `export interface X {` up to the line that closes it at column zero. Crude, and exact for
    // this codebase, where every interface is written that way.
    for (const block of source.matchAll(/export interface ([A-Za-z0-9_]+)[^{]*\{([\s\S]*?)\n\}/g)) {
      const [, name = '', body = ''] = block;
      if (NOT_DOCUMENT_STATE.has(name)) continue;
      for (const property of body.matchAll(/^ {2}readonly ([a-zA-Z0-9_]+)\??:/gm)) {
        fields.set(property[1]!, name);
      }
    }
  }

  return fields;
}

/** Every key appearing anywhere in a JSON tree. */
function keysIn(value: unknown, found: Set<string> = new Set()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysIn(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysIn(child, found);
    }
  }
  return found;
}

describe('the saved file', () => {
  it('carries every field the document model declares', () => {
    const written = keysIn(JSON.parse(saveDocument(richDocument())));
    const missing = [...declaredFields()]
      .filter(([field]) => !written.has(field))
      // Named with the interface that declares it, because "muted is missing" sends someone through
      // four files and "Track.muted is missing" does not.
      .map(([field, owner]) => `${owner}.${field}`)
      .sort();

    expect(missing).toEqual([]);
  });

  it('is checked against a model this can actually read', () => {
    // The failure this check has no other defence against: a change to how interfaces are written
    // that makes the scan find nothing, after which it passes forever and means nothing.
    const fields = declaredFields();
    expect(fields.size).toBeGreaterThan(50);
    expect(fields.get('collapsed')).toBe('TrackBase');
  });

  it('leaves nothing exempt that is part of a project', () => {
    // An exemption is a piece of the model this no longer looks at. Two is a list someone can hold in
    // their head; a dozen is a list nobody reads.
    expect(NOT_DOCUMENT_STATE.size).toBeLessThanOrEqual(4);
  });
});
