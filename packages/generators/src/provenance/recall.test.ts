import { describe, expect, it } from 'vitest';
import { assetPath, generatorId, jobRunId, presetId } from '@nos/core';
import type { GeneratorManifest } from '../contracts/manifest.js';
import type { AssetProvenance } from './asset-provenance.js';
import { isRecallable, recallRun } from './recall.js';

/**
 * Recalling a run from what was recorded of it.
 *
 * The provenance contract records the generator, the preset, the seed and every parameter precisely so
 * a result can be reproduced. Until this it could only be read — a seed you cannot feed back is a
 * receipt rather than a tool.
 *
 * What is worth pinning down is the disagreement: a manifest is a file a user edits, so by the time a
 * take is recalled its parameters may have been renamed and its presets deleted.
 */

const manifest: GeneratorManifest = {
  id: generatorId('stable_audio_3'),
  name: 'Stable Audio 3',
  backend: 'comfyui',
  graph: 'audio.json',
  produces: 'audio',
  consumes: [],
  duration: 'declared',
  defaultVariants: 3,
  surfaces: [],
  requires: [],
  outputs: [{ key: 'audio', type: 'audio', node: '57' }],
  params: [
    { key: 'description', type: 'text', bind: '/6/inputs/text' },
    { key: 'seed', type: 'seed', bind: '/57/inputs/seed' },
  ],
  presets: [{ id: presetId('oneshot'), name: 'One-shot', pin: {} }],
};

/**
 * A record, with anything overridden.
 *
 * The optional fields are spread conditionally rather than assigned, because
 * `exactOptionalPropertyTypes` refuses an explicit `undefined` for them — and "a generator that
 * records no seed" is exactly the case worth constructing.
 */
function provenance(
  overrides: {
    readonly generator?: AssetProvenance['generator'];
    readonly params?: AssetProvenance['params'];
    readonly seed?: number | undefined;
    readonly preset?: AssetProvenance['preset'] | undefined;
  } = {},
): AssetProvenance {
  const seed = 'seed' in overrides ? overrides.seed : 726741969;

  return {
    asset: assetPath('generated/take.flac'),
    generator: overrides.generator ?? generatorId('stable_audio_3'),
    generatorName: 'Stable Audio 3',
    backend: 'comfyui',
    run: jobRunId('run_0002'),
    createdAt: '2026-08-08T15:50:36.223Z',
    params: overrides.params ?? { description: 'a short metallic clang' },
    ...(seed !== undefined ? { seed } : {}),
    ...(overrides.preset !== undefined ? { preset: overrides.preset } : {}),
  };
}

describe('asking for a variation', () => {
  it('keeps every setting that made the take', () => {
    const recalled = recallRun({ provenance: provenance(), manifest });
    expect(recalled.params).toEqual({ description: 'a short metallic clang' });
    expect(recalled.generator).toBe('stable_audio_3');
  });

  it('leaves the seed free, which is what makes it a variation', () => {
    // The common case by far: everything that made a take good, and only the noise moves.
    expect(recallRun({ provenance: provenance(), manifest }).lockedSeed).toBeUndefined();
  });

  it('keeps the preset the run used', () => {
    const recalled = recallRun({ provenance: provenance({ preset: presetId('oneshot') }), manifest });
    expect(recalled.preset).toBe('oneshot');
  });
});

describe('asking for the same take again', () => {
  it('pins the seed, so the same graph makes the same file', () => {
    const recalled = recallRun({ provenance: provenance(), manifest, reproduce: true });
    expect(recalled.lockedSeed).toBe(726741969);
  });

  it('shows the seed in the field as well as pinning it', () => {
    // The record keeps the seed in its own field, not among the parameters. Without this the lock was
    // engaged and the field showed its default — the run would use the right number while the panel
    // said `0`, which is worse than showing nothing.
    const recalled = recallRun({ provenance: provenance(), manifest, reproduce: true });
    expect(recalled.params['seed']).toBe(726741969);
  });

  it('leaves the seed field alone when only a variation was asked for', () => {
    const recalled = recallRun({ provenance: provenance(), manifest });
    expect('seed' in recalled.params).toBe(false);
  });

  it('cannot pin a seed that was never recorded', () => {
    // A generator with no seed parameter records none, and pinning `undefined` would read as locked.
    const recalled = recallRun({ provenance: provenance({ seed: undefined }), manifest, reproduce: true });
    expect(recalled.lockedSeed).toBeUndefined();
    expect('lockedSeed' in recalled).toBe(false);
  });
});

describe('when the manifest has moved on', () => {
  it('drops a parameter the manifest no longer declares, and says which', () => {
    // A manifest is a file a user edits. Silently dropping three parameters would set up a run that
    // is not the one on screen.
    const recalled = recallRun({
      provenance: provenance({ params: { description: 'a clang', cfg: 4.5, wobble: 1 } }),
      manifest,
    });

    expect(recalled.params).toEqual({ description: 'a clang' });
    expect(recalled.dropped).toEqual(['cfg', 'wobble']);
  });

  it('drops a preset that has since been deleted, and says so', () => {
    const recalled = recallRun({ provenance: provenance({ preset: presetId('gone') }), manifest });
    expect(recalled.preset).toBeUndefined();
    expect(recalled.dropped).toContain('preset gone');
  });

  it('says nothing was dropped when nothing was', () => {
    expect(recallRun({ provenance: provenance(), manifest }).dropped).toEqual([]);
  });
});

describe('whether a record can be recalled at all', () => {
  it('needs the generator it names to still be installed', () => {
    expect(isRecallable(provenance(), [manifest])).toBe(true);
    expect(isRecallable(provenance({ generator: generatorId('gone') }), [manifest])).toBe(false);
    expect(isRecallable(provenance(), [])).toBe(false);
  });
});
