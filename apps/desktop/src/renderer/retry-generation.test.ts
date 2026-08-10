import { describe, expect, it } from 'vitest';
import { generatorId, jobGroupId, presetId } from '@nos/core';
import type { GeneratorManifest, JobGroup, JobRun, QueueSnapshot } from '@nos/generators';
import { type ManifestSource, retryRequest } from './retry-generation.js';

/**
 * Repeating a request that failed.
 *
 * The lookup is the part with decisions in it: the queue keeps a generator *id*, so a retry has to
 * resolve a manifest, and it has to reconstruct exactly what was asked for. Checked here rather than
 * through the shell because provoking a real backend failure end to end would mean a fault-injecting
 * mock wired into the shipped application — a test hook in production code, to cover a lookup.
 */

const MANIFEST = { id: 'stable_audio_3', name: 'Stable Audio 3' } as unknown as GeneratorManifest;

const registry: ManifestSource = {
  manifestFor: (id) => (String(id) === 'stable_audio_3' ? MANIFEST : undefined),
};

function snapshotWith(overrides: Partial<JobGroup> = {}): QueueSnapshot {
  const group = {
    id: jobGroupId('g1'),
    generator: generatorId('stable_audio_3'),
    label: 'Stable Audio 3',
    params: { prompt: 'warehouse drone', duration: 12 },
    variantCount: 3,
    target: { kind: 'media-browser' },
    status: 'failed',
    runs: [] as readonly JobRun['id'][],
    createdAt: 0,
    ...overrides,
  } as JobGroup;

  return { groups: [group], runs: [], activeCount: 0 };
}

describe('repeating a generation', () => {
  it('asks for exactly what the group asked for', () => {
    const request = retryRequest({ snapshot: snapshotWith(), registry }, jobGroupId('g1'));

    expect(request?.manifest).toBe(MANIFEST);
    expect(request?.params).toEqual({ prompt: 'warehouse drone', duration: 12 });
    expect(request?.target).toEqual({ kind: 'media-browser' });
  });

  it('keeps the variant count, which a locked seed would have silently reduced to one', () => {
    // §5.8: a locked seed forces the count to 1. Reproducing the seed would therefore have turned a
    // three-variant request into a one-variant one on the way through a retry meant to change nothing.
    expect(retryRequest({ snapshot: snapshotWith(), registry }, jobGroupId('g1'))?.variantCount).toBe(3);
  });

  it('names no seed, so the request is repeated rather than the result', () => {
    expect(retryRequest({ snapshot: snapshotWith(), registry }, jobGroupId('g1'))).not.toHaveProperty(
      'lockedSeed',
    );
  });

  it('carries the preset when there was one', () => {
    const snapshot = snapshotWith({ preset: presetId('music_bed') });
    expect(retryRequest({ snapshot, registry }, jobGroupId('g1'))?.preset).toBe('music_bed');
  });

  it('omits the preset key entirely when there was none', () => {
    // Not `preset: undefined`. Under `exactOptionalPropertyTypes` an explicit undefined is a different
    // thing from an absent key, and the queue reads this one with `in`.
    expect('preset' in retryRequest({ snapshot: snapshotWith(), registry }, jobGroupId('g1'))!).toBe(false);
  });

  it('refuses when the generator has left the library', () => {
    const snapshot = snapshotWith({ generator: generatorId('deleted_since') });
    expect(retryRequest({ snapshot, registry }, jobGroupId('g1'))).toBeUndefined();
  });

  it('refuses before the library has loaded', () => {
    expect(retryRequest({ snapshot: snapshotWith(), registry: undefined }, jobGroupId('g1'))).toBeUndefined();
  });

  it('refuses for a group the queue has forgotten', () => {
    expect(retryRequest({ snapshot: snapshotWith(), registry }, jobGroupId('gone'))).toBeUndefined();
  });
});
