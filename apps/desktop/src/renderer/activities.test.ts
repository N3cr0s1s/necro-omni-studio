import { describe, expect, it } from 'vitest';
import type { JobGroup, JobRun, QueueSnapshot } from '@nos/generators';
import { generatorActivities } from './activities.js';

/**
 * What the status bar says the generator queue is doing.
 *
 * These are assertions about *wording*, which is unusual for a test — but the wording is the entire
 * product here. A user cannot see the queue; they see one line in a footer, and every decision they
 * make from it (wait, cancel, go and look in the browser) rests on that line being true.
 *
 * The case that motivated the file: a batched submit produced three files at once while the bar read
 * "variant 1 of 3", so it looked like two more runs were still coming.
 */

const TARGET = { kind: 'media-browser' } as const;

function group(overrides: Partial<JobGroup> = {}): JobGroup {
  return {
    id: 'group_0001' as JobGroup['id'],
    generator: 'stable_audio_3' as JobGroup['generator'],
    label: 'Stable Audio 3',
    params: {},
    variantCount: 1,
    target: TARGET,
    status: 'running',
    runs: ['run_0001' as JobRun['id']],
    createdAt: 0,
    ...overrides,
  };
}

function run(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: 'run_0001' as JobRun['id'],
    group: 'group_0001' as JobGroup['id'],
    seed: 11,
    seeds: [11],
    status: 'running',
    outputs: [],
    ...overrides,
  };
}

function snapshot(groups: readonly JobGroup[], runs: readonly JobRun[]): QueueSnapshot {
  return { groups, runs, activeCount: runs.filter((r) => r.status === 'running').length };
}

const labelOf = (snap: QueueSnapshot): readonly string[] =>
  generatorActivities(snap).map((activity) => activity.label);

describe('naming a run', () => {
  it('is just the generator when there is only one variant', () => {
    // "Stable Audio 3 · variant 1 of 1" is noise, and it is the default for every video generator.
    expect(labelOf(snapshot([group()], [run()]))).toEqual(['Stable Audio 3']);
  });

  it('counts a batched run rather than numbering it', () => {
    // The observed bug. One submit, three seeds, three files — nothing further is coming, so asking
    // "which one is this?" has no answer and the bar must not imply there is one.
    const snap = snapshot([group({ variantCount: 3 })], [run({ seeds: [11, 22, 33] })]);
    expect(labelOf(snap)).toEqual(['Stable Audio 3 · 3 variants']);
  });

  it('numbers sequential runs, which really are one variant each', () => {
    const runs = [
      run({ id: 'run_0001' as JobRun['id'], seed: 11, seeds: [11] }),
      run({ id: 'run_0002' as JobRun['id'], seed: 22, seeds: [22] }),
      run({ id: 'run_0003' as JobRun['id'], seed: 33, seeds: [33] }),
    ];
    const snap = snapshot([group({ variantCount: 3, runs: runs.map((r) => r.id) })], runs);
    expect(labelOf(snap)).toEqual([
      'Stable Audio 3 · variant 1 of 3',
      'Stable Audio 3 · variant 2 of 3',
      'Stable Audio 3 · variant 3 of 3',
    ]);
  });

  it('gives a span when a run holds part of the group', () => {
    // Six variants against a graph that batches three: two runs, and the second must start at 4 —
    // numbering it "variants 1–3" twice would make two different files look like the same take.
    const runs = [
      run({ id: 'run_0001' as JobRun['id'], seeds: [11, 22, 33] }),
      run({ id: 'run_0002' as JobRun['id'], seeds: [44, 55, 66] }),
    ];
    const snap = snapshot([group({ variantCount: 6, runs: runs.map((r) => r.id) })], runs);
    expect(labelOf(snap)).toEqual([
      'Stable Audio 3 · variants 1–3 of 6',
      'Stable Audio 3 · variants 4–6 of 6',
    ]);
  });

  it('still says something for a run whose group is gone', () => {
    // A group pruned while its run is still reported would otherwise render an empty label, which
    // reads as a blank row rather than as work in progress.
    expect(labelOf(snapshot([], [run()]))).toEqual(['Generating']);
  });
});

describe('the facts under a run', () => {
  it('shows the one seed of a sequential run', () => {
    const [activity] = generatorActivities(
      snapshot([group()], [run({ seed: 726741969, seeds: [726741969] })]),
    );
    expect(activity?.facts?.[0]).toEqual({ label: 'seed', value: '726741969' });
  });

  it('shows every seed of a batched run', () => {
    // One seed shown for a submit that used three is the fact a user would put in a bug report, and
    // it would be wrong for two of the three files sitting in `generated/`.
    const snap = snapshot([group({ variantCount: 3 })], [run({ seed: 11, seeds: [11, 22, 33] })]);
    const [activity] = generatorActivities(snap);
    expect(activity?.facts?.[0]).toEqual({ label: 'seeds', value: '11, 22, 33' });
  });

  it('carries the parameters that identify a take', () => {
    const snap = snapshot([group({ params: { description: 'a short metallic clang' } })], [run()]);
    const [activity] = generatorActivities(snap);
    expect(activity?.facts).toContainEqual({ label: 'description', value: 'a short metallic clang' });
  });
});
