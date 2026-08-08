import { describe, expect, it, vi } from 'vitest';
import { generatorId, presetId, trackId, frameIndex } from '@nos/core';
import type { GeneratorManifest } from '../contracts/manifest.js';
import { createMockBackend, createRecordingPatcher } from '../backends/mock-backend.js';
import { createFixedSeedSource } from './variant-plan.js';
import { createGpuSemaphore } from './gpu-semaphore.js';
import { type JobTarget, completedRuns, createJobQueue, groupProgress, runsOf } from './job-queue.js';

function manifest(overrides: Partial<GeneratorManifest> = {}): GeneratorManifest {
  return {
    id: generatorId('stable_audio_3'),
    name: 'Stable Audio 3',
    backend: 'mock',
    graph: 'audio.json',
    produces: 'audio',
    consumes: [],
    surfaces: ['media_browser'],
    duration: 'declared',
    defaultVariants: 3,
    requires: [],
    outputs: [{ key: 'audio', type: 'audio', node: '57' }],
    params: [{ key: 'seed', type: 'seed', bind: '/52:3/inputs/seed' }],
    presets: [],
    ...overrides,
  };
}

const target: JobTarget = { kind: 'media-browser' };

function setup(
  backendOptions: Parameters<typeof createMockBackend>[0] = {},
  queueOptions: Partial<Parameters<typeof createJobQueue>[0]> = {},
) {
  const backend = createMockBackend({ progressSteps: 2, ...backendOptions });
  const patcher = createRecordingPatcher();
  const gpu = createGpuSemaphore();
  const queue = createJobQueue({
    backend,
    gpu,
    patcher: patcher as never,
    nextSeed: createFixedSeedSource([101, 102, 103, 104, 105, 106]),
    ...queueOptions,
  });
  return { backend, patcher, gpu, queue };
}

describe('groups and runs', () => {
  it('creates one run per variant', async () => {
    // The spec's two levels: a group is one user request, a run is one variant.
    const { queue } = setup();
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    const snapshot = queue.getSnapshot();
    expect(snapshot.groups).toHaveLength(1);
    expect(runsOf(snapshot, group)).toHaveLength(3);
  });

  it('gives each run a distinct seed', async () => {
    const { queue } = setup();
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    const seeds = runsOf(queue.getSnapshot(), group).map((run) => run.seed);
    expect(seeds).toEqual([101, 102, 103]);
  });

  it('passes each run its own seed to the patcher', async () => {
    // The seed has to reach the graph, or every variant renders identically.
    const { queue, patcher } = setup();
    queue.enqueue({ manifest: manifest(), params: { steps: 30 }, target });
    await queue.drain();

    expect(patcher.calls.map((call) => call.seeds)).toEqual([[101], [102], [103]]);
    expect(patcher.calls[0]!.params).toEqual({ steps: 30 });
  });

  it('records the preset for reproducibility', async () => {
    const { queue } = setup();
    const group = queue.enqueue({
      manifest: manifest(),
      preset: presetId('sfx'),
      params: {},
      target,
    });
    await queue.drain();
    expect(queue.getSnapshot().groups[0]!.preset).toBe('sfx');
    void group;
  });

  it('carries the timeline target', async () => {
    const { queue } = setup();
    queue.enqueue({
      manifest: manifest(),
      params: {},
      target: { kind: 'timeline', track: trackId('a1'), at: frameIndex(120) },
    });
    await queue.drain();
    expect(queue.getSnapshot().groups[0]!.target).toEqual({
      kind: 'timeline',
      track: 'a1',
      at: 120,
    });
  });
});

describe('completion', () => {
  it('completes every run and the group', async () => {
    const { queue } = setup();
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    const snapshot = queue.getSnapshot();
    expect(runsOf(snapshot, group).every((run) => run.status === 'complete')).toBe(true);
    expect(snapshot.groups[0]!.status).toBe('complete');
  });

  it('collects outputs onto the run', async () => {
    const { queue } = setup();
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    const outputs = completedRuns(queue.getSnapshot(), group)[0]!.outputs;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.path).toContain('generated/');
  });

  it('reports progress from the backend', async () => {
    const { queue } = setup();
    const seen: number[] = [];
    queue.subscribe((snapshot) => {
      const run = snapshot.runs[0];
      if (run?.progress !== undefined) seen.push(run.progress);
    });

    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    expect(seen).toContain(0.5);
    expect(seen).toContain(1);
  });

  it('counts active runs for the title bar chip', async () => {
    const { queue } = setup();
    let peak = 0;
    queue.subscribe((snapshot) => {
      peak = Math.max(peak, snapshot.activeCount);
    });

    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    expect(peak).toBe(3);
    expect(queue.getSnapshot().activeCount).toBe(0);
  });
});

describe('partial results', () => {
  it('marks a group partial when some runs succeed and some fail', async () => {
    // Two usable results out of three is not a failure; reporting it as one would hide them.
    const { queue } = setup({ failSubmitOn: [2] });
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    const snapshot = queue.getSnapshot();
    expect(snapshot.groups[0]!.status).toBe('partial');
    expect(completedRuns(snapshot, group)).toHaveLength(2);
  });

  it('makes a finished run usable while its siblings are still going', async () => {
    // The spec requires partial results to be immediately auditionable.
    const { queue } = setup({ stepDelayMs: 2 });
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });

    let sawUsableWhileRunning = false;
    queue.subscribe((snapshot) => {
      const done = completedRuns(snapshot, group).length;
      const active = snapshot.activeCount;
      if (done > 0 && active > 0) sawUsableWhileRunning = true;
    });

    await queue.drain();
    expect(sawUsableWhileRunning).toBe(true);
  });

  it('fails the group only when every run failed', async () => {
    const { queue } = setup({ failSubmitOn: [1, 2, 3] });
    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();
    expect(queue.getSnapshot().groups[0]!.status).toBe('failed');
  });

  it('records why a run failed', async () => {
    const { queue } = setup({ failSubmitOn: [1] });
    queue.enqueue({ manifest: manifest({ defaultVariants: 1 }), params: {}, target });
    await queue.drain();
    expect(queue.getSnapshot().runs[0]!.error).toContain('rejected');
  });

  it('reports a collect failure distinctly from a submit failure', async () => {
    const { queue } = setup({ failCollectOn: [1] });
    queue.enqueue({ manifest: manifest({ defaultVariants: 1 }), params: {}, target });
    await queue.drain();
    expect(queue.getSnapshot().runs[0]!.error).toContain('graph failed');
  });
});

describe('cancellation', () => {
  it('cancels a queued run without waiting for a turn it will never take', async () => {
    const { queue } = setup({ stepDelayMs: 5 });
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });

    const queuedRun = runsOf(queue.getSnapshot(), group)[2]!;
    queue.cancelRun(queuedRun.id);
    await queue.drain();

    const after = runsOf(queue.getSnapshot(), group).find((run) => run.id === queuedRun.id);
    expect(after?.status).toBe('cancelled');
  });

  it('cancels a whole group', async () => {
    const { queue } = setup({ stepDelayMs: 5 });
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    queue.cancelGroup(group);
    await queue.drain();

    const runs = runsOf(queue.getSnapshot(), group);
    expect(runs.every((run) => run.status === 'cancelled' || run.status === 'complete')).toBe(true);
  });

  it('does not report a cancelled run as failed', async () => {
    // Failed runs are worth surfacing; cancelled ones are not, and conflating them produces noise the
    // user caused deliberately.
    const { queue } = setup({ stepDelayMs: 5 });
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    queue.cancelGroup(group);
    await queue.drain();

    expect(runsOf(queue.getSnapshot(), group).every((run) => run.error === undefined)).toBe(true);
  });

  it('releases the GPU when a run is cancelled', async () => {
    // A cancelled run stranding the semaphore would deadlock every later job.
    const { queue, gpu } = setup({ stepDelayMs: 5 });
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    queue.cancelGroup(group);
    await queue.drain();

    expect(gpu.getStatus().holder).toBeUndefined();
    expect(gpu.getStatus().waiting).toHaveLength(0);
  });
});

describe('GPU serialization', () => {
  it('runs one job at a time', async () => {
    // The whole point of the semaphore: concurrent runs would exhaust VRAM.
    const { queue, gpu } = setup({ stepDelayMs: 2 });
    let peakHolders = 0;
    gpu.subscribe((status) => {
      peakHolders = Math.max(peakHolders, status.holder === undefined ? 0 : 1);
    });

    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    expect(peakHolders).toBe(1);
    expect(gpu.getStatus().holder).toBeUndefined();
  });

  it('releases the GPU even when a run fails', async () => {
    const { queue, gpu } = setup({ failSubmitOn: [1, 2, 3] });
    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();
    expect(gpu.getStatus().holder).toBeUndefined();
  });

  it('reports the waiting state, so a stalled job is explained', async () => {
    const { queue } = setup({ stepDelayMs: 2 });
    const seen = new Set<string>();
    queue.subscribe((snapshot) => {
      for (const run of snapshot.runs) seen.add(run.status);
    });

    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    expect(seen.has('waiting-for-gpu')).toBe(true);
  });
});

describe('variant constraints', () => {
  it('records why the count was reduced', async () => {
    // The spec requires the UI to explain, not silently disagree.
    const { queue } = setup();
    queue.enqueue({
      manifest: manifest({ params: [] }),
      params: {},
      target,
      variantCount: 3,
    });
    await queue.drain();

    expect(queue.getSnapshot().groups[0]!.constraintNote).toContain('no seed parameter');
    expect(queue.getSnapshot().groups[0]!.variantCount).toBe(1);
  });

  it('adds no note when nothing was constrained', async () => {
    const { queue } = setup();
    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();
    expect(queue.getSnapshot().groups[0]!.constraintNote).toBeUndefined();
  });

  it('honours a locked seed', async () => {
    const { queue } = setup();
    const group = queue.enqueue({ manifest: manifest(), params: {}, target, lockedSeed: 4471 });
    await queue.drain();

    const runs = runsOf(queue.getSnapshot(), group);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.seed).toBe(4471);
  });

  it('creates one run per batch in batched mode', async () => {
    const { queue, patcher } = setup();
    queue.enqueue({
      manifest: manifest({ batch: { bind: '/x', max: 2 } }),
      params: {},
      target,
      variantCount: 4,
    });
    await queue.drain();

    // Four variants at a batch max of two is two submits, each carrying two seeds.
    expect(patcher.calls).toHaveLength(2);
    expect(patcher.calls.map((call) => call.seeds)).toEqual([
      [101, 102],
      [103, 104],
    ]);
  });
});

describe('backend failures', () => {
  it('fails every run when the backend is unreachable', async () => {
    const { queue } = setup({ unreachable: true });
    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();

    const snapshot = queue.getSnapshot();
    expect(snapshot.groups[0]!.status).toBe('failed');
    expect(snapshot.runs.every((run) => run.error?.includes('not reachable'))).toBe(true);
  });

  it('still collects when the progress stream dies', async () => {
    // A dead progress stream is not proof the job failed; the output may exist.
    const backend = createMockBackend({ progressSteps: 1 });
    const failing = {
      ...backend,

      async *progress(): AsyncIterable<never> {
        throw new Error('socket closed');
      },
    };
    const queue = createJobQueue({
      backend: failing as never,
      gpu: createGpuSemaphore(),
      patcher: createRecordingPatcher() as never,
      nextSeed: createFixedSeedSource([1]),
    });

    queue.enqueue({ manifest: manifest({ defaultVariants: 1 }), params: {}, target });
    await queue.drain();

    expect(queue.getSnapshot().runs[0]!.status).toBe('complete');
  });
});

describe('progress aggregation', () => {
  it('reports one figure covering every variant', async () => {
    const { queue } = setup();
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();
    expect(groupProgress(queue.getSnapshot(), group)).toBe(1);
  });

  it('counts a failed run as settled, so the bar reaches the end', async () => {
    // A bar stuck at 66% after everything finished reads as a hang.
    const { queue } = setup({ failSubmitOn: [2] });
    const group = queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();
    expect(groupProgress(queue.getSnapshot(), group)).toBe(1);
  });
});

describe('subscriptions', () => {
  it('notifies on every state change', async () => {
    const { queue } = setup();
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();
    expect(listener.mock.calls.length).toBeGreaterThan(3);
  });

  it('stops notifying after unsubscribe', async () => {
    const { queue } = setup();
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    unsubscribe();
    queue.enqueue({ manifest: manifest(), params: {}, target });
    await queue.drain();
    expect(listener).not.toHaveBeenCalled();
  });
});
