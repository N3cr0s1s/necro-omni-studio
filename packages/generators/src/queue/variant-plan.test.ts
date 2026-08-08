import { describe, expect, it } from 'vitest';
import { generatorId, presetId } from '@nos/core';
import type { GeneratorManifest } from '../contracts/manifest.js';
import {
  MAX_VARIANTS,
  createFixedSeedSource,
  createSeedSource,
  describeConstraint,
  planVariants,
} from './variant-plan.js';

/** The spec's Stable Audio manifest: a seed parameter and a batch block, default three variants. */
function manifest(overrides: Partial<GeneratorManifest> = {}): GeneratorManifest {
  return {
    id: generatorId('stable_audio_3'),
    name: 'Stable Audio 3',
    backend: 'comfyui',
    graph: 'audio.json',
    produces: 'audio',
    consumes: [],
    surfaces: ['media_browser', 'audio_track_empty'],
    duration: 'declared',
    defaultVariants: 3,
    batch: { bind: '/52:11/inputs/batch_size', max: 4 },
    requires: [],
    outputs: [{ key: 'audio', type: 'audio', node: '57' }],
    params: [{ key: 'seed', type: 'seed', bind: '/52:3/inputs/seed' }],
    presets: [],
    ...overrides,
  };
}

const seeds = createFixedSeedSource([11, 22, 33, 44, 55, 66, 77]);

/**
 * A manifest with no batch block, i.e. one whose graph cannot produce variants in a single submit.
 *
 * A helper rather than `manifest({ batch: undefined })`: under exactOptionalPropertyTypes an absent
 * optional and a present-but-undefined one are different types, and "the manifest omits batch" is the
 * state being modelled.
 */
function manifestWithoutBatch(): GeneratorManifest {
  const { batch, ...rest } = manifest();
  void batch;
  return rest;
}

const plan = (overrides: Parameters<typeof planVariants>[0] extends infer T ? Partial<T> : never) =>
  planVariants({ manifest: manifest(), nextSeed: createFixedSeedSource([11, 22, 33, 44, 55, 66, 77]), ...overrides });

describe('seed constraint', () => {
  it('forces one variant when the manifest has no seed parameter', () => {
    // Without a seed, N runs would return N identical results.
    const result = plan({ manifest: manifest({ params: [] }), requested: 4 });
    expect(result.totalVariants).toBe(1);
    expect(result.constraint).toEqual({ kind: 'no-seed-parameter' });
  });

  it('forces one variant when the seed is locked', () => {
    const result = plan({ requested: 4, lockedSeed: 4471 });
    expect(result.totalVariants).toBe(1);
    expect(result.batches[0]!.seeds).toEqual([4471]);
    expect(result.constraint).toEqual({ kind: 'seed-locked' });
  });

  it('explains the constraint, rather than silently disagreeing with the user', () => {
    // The spec requires the reason to be shown, not just the reduced count.
    const result = plan({ manifest: manifest({ params: [] }), requested: 3 });
    expect(describeConstraint(result.constraint!)).toContain('no seed parameter');
  });

  it('reports no constraint when the user only asked for one anyway', () => {
    // Explaining a limit the user did not hit is noise, and noise trains people to ignore explanations.
    const result = plan({ manifest: manifest({ params: [] }), requested: 1 });
    expect(result.constraint).toBeUndefined();
  });
});

describe('sequential mode', () => {
  it('is the default when the manifest declares no batch block', () => {
    // Sequential works on any graph and each run can be cancelled independently.
    const result = plan({ manifest: manifestWithoutBatch(), requested: 3 });
    expect(result.mode).toBe('sequential');
    expect(result.batches).toHaveLength(3);
    expect(result.batches.every((batch) => batch.seeds.length === 1)).toBe(true);
  });

  it('gives every run a distinct seed', () => {
    const result = plan({ manifest: manifestWithoutBatch(), requested: 3 });
    const allSeeds = result.batches.flatMap((batch) => batch.seeds);
    expect(new Set(allSeeds).size).toBe(3);
  });
});

describe('batched mode', () => {
  it('produces one submit when the count fits the batch maximum', () => {
    const result = plan({ requested: 3 });
    expect(result.mode).toBe('batched');
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]!.seeds).toHaveLength(3);
  });

  it('splits above the maximum rather than failing or falling back entirely', () => {
    // The spec's example: six variants with a max of three is two batched runs.
    const result = plan({ manifest: manifest({ batch: { bind: '/x', max: 3 } }), requested: 6 });
    expect(result.batches).toHaveLength(2);
    expect(result.batches.map((batch) => batch.seeds.length)).toEqual([3, 3]);
    expect(result.totalVariants).toBe(6);
  });

  it('leaves a short final batch rather than padding it', () => {
    const result = plan({ manifest: manifest({ batch: { bind: '/x', max: 3 } }), requested: 5 });
    expect(result.batches.map((batch) => batch.seeds.length)).toEqual([3, 2]);
  });

  it('produces the same total whichever mode is used', () => {
    const batched = plan({ requested: 4 });
    const sequential = plan({ manifest: manifestWithoutBatch(), requested: 4 });
    expect(batched.totalVariants).toBe(sequential.totalVariants);
  });
});

describe('defaults and limits', () => {
  it('uses the manifest default when nothing is requested', () => {
    // The spec sets audio to three and video to one, as a manifest-level decision.
    expect(plan({}).totalVariants).toBe(3);
    expect(plan({ manifest: manifest({ defaultVariants: 1 }) }).totalVariants).toBe(1);
  });

  it('caps at the global maximum and says so', () => {
    const result = plan({ requested: 100, globalMaximum: 4 });
    expect(result.totalVariants).toBe(4);
    expect(result.constraint).toEqual({ kind: 'above-maximum', maximum: 4 });
  });

  it('has a sane built-in ceiling', () => {
    expect(MAX_VARIANTS).toBeGreaterThan(1);
    expect(plan({ requested: 1000 }).totalVariants).toBeLessThanOrEqual(MAX_VARIANTS);
  });

  it('never plans fewer than one variant', () => {
    for (const requested of [0, -5]) {
      expect(plan({ requested }).totalVariants).toBe(1);
    }
  });

  it('rounds a fractional request', () => {
    expect(plan({ requested: 2.6 }).totalVariants).toBe(3);
  });
});

describe('seed sources', () => {
  it('produces seeds inside the range every backend accepts', () => {
    const source = createSeedSource(() => 0.5);
    const seed = source();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });

  it('is deterministic when replaying a recorded run', () => {
    const source = createFixedSeedSource([7, 8]);
    expect([source(), source(), source()]).toEqual([7, 8, 7]);
  });

  it('makes a plan reproducible', () => {
    const first = planVariants({ manifest: manifest(), requested: 3, nextSeed: createFixedSeedSource([1, 2, 3]) });
    const second = planVariants({ manifest: manifest(), requested: 3, nextSeed: createFixedSeedSource([1, 2, 3]) });
    expect(first).toEqual(second);
  });
});

describe('seed ordering', () => {
  it('draws seeds in order, so a run can be reproduced from its recorded seed', () => {
    void seeds;
    const result = planVariants({
      manifest: manifestWithoutBatch(),
      requested: 3,
      nextSeed: createFixedSeedSource([101, 102, 103]),
    });
    expect(result.batches.flatMap((batch) => batch.seeds)).toEqual([101, 102, 103]);
  });
});
