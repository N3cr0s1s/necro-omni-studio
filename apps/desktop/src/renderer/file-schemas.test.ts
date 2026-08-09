import { describe, expect, it } from 'vitest';
import { FILE_SCHEMAS, schemaFor } from './file-schemas.js';

/**
 * Which description applies to which file, per issue #31.
 */

describe('matching a path', () => {
  it('treats a manifest in generators/ as a generator manifest', () => {
    expect(schemaFor('generators/stable_audio_3.manifest.json')?.id).toBe('generator-manifest');
  });

  it('treats a manifest in effects/ as an effect manifest', () => {
    expect(schemaFor('effects/tint.json')?.id).toBe('effect-manifest');
  });

  it('leaves a graph alone', () => {
    // Graphs live in the same folder and are ComfyUI's format, not this application's. Describing them
    // would offer manifest fields inside a graph, confidently and wrongly.
    expect(schemaFor('generators/krea.graph.json')).toBeUndefined();
  });

  it('claims nothing outside the folders it knows', () => {
    expect(schemaFor('project.json')).toBeUndefined();
    expect(schemaFor('notes/plan.json')).toBeUndefined();
  });

  it('claims nothing that is not JSON', () => {
    expect(schemaFor('effects/tint.frag')).toBeUndefined();
  });

  it('follows the path on either separator, because it comes from the operating system', () => {
    expect(schemaFor('effects\\tint.json')?.id).toBe('effect-manifest');
  });

  it('ignores case in the folder and the extension', () => {
    expect(schemaFor('Effects/Tint.JSON')?.id).toBe('effect-manifest');
  });
});

describe('the registry itself', () => {
  it('names every entry, so a mismatch can be reported rather than being silence', () => {
    expect(FILE_SCHEMAS.every((entry) => entry.id !== '')).toBe(true);
  });

  it('gives every entry a distinct name', () => {
    expect(new Set(FILE_SCHEMAS.map((entry) => entry.id)).size).toBe(FILE_SCHEMAS.length);
  });

  it('can be asked with a registry of its own, which is what makes it extensible', () => {
    const custom = [
      {
        id: 'notes',
        matches: (path: string) => path.endsWith('.note.json'),
        shape: { kind: 'unknown' } as const,
      },
    ];
    expect(schemaFor('a.note.json', custom)?.id).toBe('notes');
  });
});
