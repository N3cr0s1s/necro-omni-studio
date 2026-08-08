import { describe, expect, it } from 'vitest';
import { parseManifestFile, serializeManifest } from './manifest-file.js';

describe('a preset’s starting values on disk', () => {
  const file = {
    id: 'g',
    name: 'G',
    backend: 'comfyui',
    graph: 'g.json',
    produces: 'audio',
    consumes: [],
    surfaces: [],
    duration: 'declared',
    default_variants: 1,
    requires: [],
    outputs: [],
    params: [{ key: 'duration_s', type: 'float', bind: '/a', default: 50 }],
    presets: [{ id: 'sfx', name: 'SFX', pin: { category: 'SFX' }, set: { duration_s: 5 } }],
  };

  it('reads `set` alongside `pin`', () => {
    const parsed = parseManifestFile(file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.presets[0]?.pin).toEqual({ category: 'SFX' });
    expect(parsed.value.presets[0]?.set).toEqual({ duration_s: 5 });
  });

  it('writes it back, so the authoring tool cannot silently drop it', () => {
    const parsed = parseManifestFile(file);
    if (!parsed.ok) throw new Error('expected a manifest');
    // `serializeManifest` answers with the file's own shape, not a string.
    const written = serializeManifest(parsed.value) as unknown as {
      presets: readonly Record<string, unknown>[];
    };
    expect(written.presets[0]?.['set']).toEqual({ duration_s: 5 });
  });

  it('refuses a `set` that is not an object of values', () => {
    const broken = { ...file, presets: [{ id: 'sfx', name: 'SFX', pin: {}, set: 5 }] };
    expect(parseManifestFile(broken).ok).toBe(false);
  });
});
