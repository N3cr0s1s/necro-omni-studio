import { describe, expect, it } from 'vitest';
import { generatorId, presetId } from '@nos/core';
import type { GeneratorManifest, GeneratorPreset } from './manifest.js';
import { effectiveDefaults, visibleParams } from './manifest.js';

/**
 * What a preset takes away, and what it merely offers.
 *
 * The distinction was missing: every value a preset carried was a lock, so a one-shot preset that
 * came with a two-second length left no way to ask for three. The control was *gone*, not
 * pre-filled — which is the report "the length cannot be set on stable audio".
 */
function manifest(presets: readonly GeneratorPreset[]): GeneratorManifest {
  return {
    id: generatorId('stable_audio_3'),
    name: 'Stable Audio 3',
    backend: 'comfyui',
    graph: 'audio.json',
    produces: 'audio',
    consumes: [],
    surfaces: [],
    duration: 'declared',
    durationFrom: { param: 'duration_s', unit: 'seconds' },
    defaultVariants: 1,
    requires: [],
    outputs: [],
    params: [
      { key: 'category', type: 'enum', bind: '/a', options: ['Music', 'SFX'], default: 'Music' },
      { key: 'duration_s', type: 'float', bind: '/b', min: 1, max: 190, default: 50 },
      { key: 'steps', type: 'int', bind: '/c', default: 50 },
    ],
    presets,
  };
}

const keys = (manifest: GeneratorManifest, preset: string) =>
  visibleParams(manifest, presetId(preset)).map((param) => param.key);

describe('a pinned value', () => {
  it('is hidden, which is what makes a preset its own tool', () => {
    const sfx = manifest([{ id: presetId('sfx'), name: 'SFX', pin: { category: 'SFX' } }]);
    expect(keys(sfx, 'sfx')).toEqual(['duration_s', 'steps']);
  });

  it('is applied over the manifest’s default', () => {
    const sfx = manifest([{ id: presetId('sfx'), name: 'SFX', pin: { category: 'SFX' } }]);
    expect(effectiveDefaults(sfx, presetId('sfx'))['category']).toBe('SFX');
  });
});

describe('a value a preset only sets', () => {
  const sfx = manifest([
    { id: presetId('sfx'), name: 'SFX', pin: { category: 'SFX' }, set: { duration_s: 5 } },
  ]);

  it('stays visible, because it is a starting point rather than a decision taken away', () => {
    // The whole fix: SFX and One-shot pinned the length, so choosing either removed the only control
    // for the thing the user most wanted to change.
    expect(keys(sfx, 'sfx')).toContain('duration_s');
  });

  it('is pre-filled with what the preset chose', () => {
    expect(effectiveDefaults(sfx, presetId('sfx'))['duration_s']).toBe(5);
  });

  it('leaves the other defaults alone', () => {
    expect(effectiveDefaults(sfx, presetId('sfx'))['steps']).toBe(50);
  });
});

describe('when a preset both sets and pins the same key', () => {
  it('the pin wins, since it is the value that cannot be argued with', () => {
    // Otherwise the result would depend on which was written first in the file.
    const odd = manifest([
      { id: presetId('odd'), name: 'Odd', pin: { duration_s: 9 }, set: { duration_s: 3 } },
    ]);
    expect(effectiveDefaults(odd, presetId('odd'))['duration_s']).toBe(9);
    expect(keys(odd, 'odd')).not.toContain('duration_s');
  });
});

describe('with no preset chosen', () => {
  it('every parameter is shown', () => {
    const plain = manifest([{ id: presetId('sfx'), name: 'SFX', pin: { category: 'SFX' } }]);
    expect(visibleParams(plain).map((param) => param.key)).toEqual(['category', 'duration_s', 'steps']);
  });

  it('the defaults are the manifest’s own', () => {
    const plain = manifest([]);
    expect(effectiveDefaults(plain)).toEqual({ category: 'Music', duration_s: 50, steps: 50 });
  });
});

describe('a preset that does not exist', () => {
  it('hides nothing rather than everything', () => {
    // A stale preset id in a saved project must not empty the panel.
    const plain = manifest([]);
    expect(visibleParams(plain, presetId('gone')).map((param) => param.key)).toHaveLength(3);
    expect(effectiveDefaults(plain, presetId('gone'))['duration_s']).toBe(50);
  });
});
