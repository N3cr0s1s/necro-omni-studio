import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTHORED_MANIFEST } from './authored-manifest.js';
import { fromManifest, toManifest } from './manifest-draft.js';

/**
 * Every field of the manifest contract survives the inspector.
 *
 * §5.6 lets a new generative capability be a JSON file authored from inside the application. That
 * makes the inspector's round trip — open a manifest, edit one thing, write it back — the most
 * dangerous path in this codebase, because it rewrites a file the user did not ask it to rewrite. A
 * field the draft cannot hold is not a field that fails to save; it is a field **deleted from a
 * manifest that already worked**.
 *
 * It has happened three times. Each time the fix was one field, and each time the next was already
 * waiting, because a hand-written fixture decided which fields were checked and it had never been
 * asked whether it was complete.
 *
 * So this asks. It reads the property names out of the contract's own source, drives the fixture
 * through the inspector's draft and back, and asserts every declared name is still there. A field
 * missing is either dropped by the round trip or never exercised by the fixture, and from a user's
 * chair those are the same bug.
 *
 * The most recent one it found: `options` was typed as a list, so the three shipped manifests that
 * fill a dropdown from the backend's node definitions had that source silently removed — sampler,
 * scheduler, LoRA and aspect ratio all became free text.
 */

/**
 * Contract types that are not part of a manifest file.
 *
 * Short on purpose: each entry is a piece of the contract this check no longer looks at.
 */
const NOT_MANIFEST_STATE: ReadonlySet<string> = new Set([
  // What a surface offers in a menu. Built from the registry at runtime; no manifest declares one.
  'GeneratorEntry',
]);

/**
 * Fields the writer derives rather than carries, with the reason.
 *
 * `status` is a fact about the graph, not a preference: `draftManifestJson` sets `unbound` when the
 * graph is missing or a pointer is empty, and omits it otherwise. Carrying a stored value through
 * would let a manifest keep claiming to be unrunnable after its graph was connected — the derivation
 * is the design, so the round trip is *expected* not to preserve it.
 */
const DERIVED: ReadonlySet<string> = new Set(['status']);

function declaredFields(): ReadonlyMap<string, string> {
  const source = readFileSync(new URL('../contracts/manifest.ts', import.meta.url).pathname, 'utf8');
  const fields = new Map<string, string>();

  for (const block of source.matchAll(/export interface ([A-Za-z0-9_]+)[^{]*\{([\s\S]*?)\n\}/g)) {
    const [, name = '', body = ''] = block;
    if (NOT_MANIFEST_STATE.has(name)) continue;
    for (const property of body.matchAll(/^ {2}readonly ([a-zA-Z0-9_]+)\??:/gm)) {
      if (!DERIVED.has(property[1]!)) fields.set(property[1]!, name);
    }
  }

  return fields;
}

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

describe('a manifest opened and written back', () => {
  it('still carries every field the contract declares', () => {
    const survived = keysIn(toManifest(fromManifest(AUTHORED_MANIFEST)));
    const missing = [...declaredFields()]
      .filter(([field]) => !survived.has(field))
      // Named with the interface that declares it: "options is missing" sends someone through the
      // whole contract, "GeneratorParam.options is missing" does not.
      .map(([field, owner]) => `${owner}.${field}`)
      .sort();

    expect(missing).toEqual([]);
  });

  it('is checked against a contract this can actually read', () => {
    // The failure with no other defence: a change to how the contract is written that makes the scan
    // find nothing, after which this passes forever and means nothing.
    const fields = declaredFields();
    expect(fields.size).toBeGreaterThan(30);
    expect(fields.get('exclusive')).toBe('GeneratorManifest');
    expect(fields.get('also')).toBe('GeneratorParam');
  });

  it('leaves nothing exempt that a manifest can declare', () => {
    expect(NOT_MANIFEST_STATE.size + DERIVED.size).toBeLessThanOrEqual(3);
  });
});
