import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GeneratorManifest } from '../contracts/manifest.js';
import { draftHasErrors, fromManifest, validateDraft } from './manifest-draft.js';
import { draftToFile, parseManifestFile } from './manifest-file.js';

/**
 * The manifests this project actually ships, opened in the inspector and written back.
 *
 * The fixture-based checks beside this one prove the draft is self-consistent and that no *declared*
 * field is dropped. Neither can tell you whether the five files in `generators/` survive the round
 * trip, and those are the files a user opens. Every regression the inspector has had was found in one
 * of them, after it had shipped.
 *
 * So this reads them off disk, parses each as the registry does, opens it as a draft, writes it back
 * out, and parses that. Two things are asserted, and they are different claims:
 *
 * - **Nothing is lost.** The re-parsed manifest equals the original. That is the data-loss check.
 * - **Nothing is falsely rejected.** The draft reports no errors. Opening a shipped manifest and
 *   being told it is invalid is its own bug, and it is the one that hid here: `options` given as a
 *   capability source has no `length`, so a validator written around a list reported four
 *   perfectly good dropdowns as "an enum needs options".
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const shipped = readdirSync(`${repoRoot}/generators`).filter((name) => name.endsWith('.manifest.json'));

describe('the manifests in generators/', () => {
  it('are there to be checked at all', () => {
    // A directory that stopped matching would make every case below vanish and the file pass empty.
    expect(shipped.length).toBeGreaterThanOrEqual(5);
  });

  /** The manifest as the registry reads it, or a failure that names what was wrong with the file. */
  function shippedManifest(name: string): GeneratorManifest {
    const parsed = parseManifestFile(JSON.parse(readFileSync(`${repoRoot}/generators/${name}`, 'utf8')));
    if (!parsed.ok) {
      throw new Error(
        `${name} does not parse: ${parsed.error.map((issue) => `${issue.path} ${issue.message}`).join(', ')}`,
      );
    }
    return parsed.value;
  }

  it.each(shipped)('%s parses', (name) => {
    expect(() => shippedManifest(name)).not.toThrow();
  });

  it.each(shipped)('%s survives being opened and written back', (name) => {
    const original = shippedManifest(name);
    const rewritten = parseManifestFile(draftToFile(fromManifest(original)));

    expect(rewritten.ok).toBe(true);
    if (rewritten.ok) expect(rewritten.value).toEqual(original);
  });

  it.each(shipped)('%s is not reported as broken by the editor that opens it', (name) => {
    const draft = fromManifest(shippedManifest(name));
    const errors = validateDraft(draft).filter((issue) => issue.severity === 'error');

    // Named rather than counted: a failure should say which parameter and why.
    expect(errors.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([]);
    expect(draftHasErrors(draft)).toBe(false);
  });
});
