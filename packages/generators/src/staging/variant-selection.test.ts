import { describe, expect, it } from 'vitest';
import {
  FRAME_RATES,
  assetPath,
  frameCount,
  frameIndex,
  generatorId,
  jobGroupId,
  jobRunId,
  trackId,
} from '@nos/core';
import type { GeneratorManifest } from '../contracts/manifest.js';
import type { JobGroup, JobRun } from '../queue/job-queue.js';
import { placeholderLength } from './placeholder.js';
import {
  acceptSelection,
  buildSelection,
  describeSelection,
  discardSelection,
  primaryOutput,
  selectCandidate,
  stepSelection,
} from './variant-selection.js';

const manifest: GeneratorManifest = {
  id: generatorId('stable_audio_3'),
  name: 'Stable Audio 3',
  backend: 'comfyui',
  graph: 'audio.json',
  produces: 'audio',
  consumes: [],
  surfaces: ['media_browser'],
  duration: 'declared',
  defaultVariants: 3,
  requires: [],
  outputs: [{ key: 'audio', type: 'audio', node: '57' }],
  params: [
    { key: 'duration_s', type: 'float', default: 50, bind: '/a' },
    { key: 'seed', type: 'seed', bind: '/b' },
  ],
  presets: [],
};

const group: JobGroup = {
  id: jobGroupId('g1'),
  generator: manifest.id,
  label: 'Stable Audio 3',
  params: {},
  variantCount: 3,
  target: { kind: 'timeline', track: trackId('t1'), at: frameIndex(120) },
  status: 'running',
  runs: [jobRunId('r1'), jobRunId('r2'), jobRunId('r3')],
  createdAt: 0,
};

function run(id: string, overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: jobRunId(id),
    group: group.id,
    seed: 1,
    seeds: [1],
    status: 'queued',
    outputs: [],
    ...overrides,
  };
}

const done = (id: string, seed: number, file: string): JobRun =>
  run(id, {
    seed,
    status: 'complete',
    outputs: [{ key: '57', type: 'audio', path: assetPath(`generated/${file}`) }],
  });

const selectionOf = (runs: readonly JobRun[], current?: string) =>
  buildSelection({
    group,
    runs,
    manifest,
    ...(current !== undefined ? { current: jobRunId(current) } : {}),
  });

describe('building a selection', () => {
  it('numbers candidates by the group order, not by arrival', () => {
    // Runs finish out of order; a picker that renumbered on completion would relabel a variant the user is
    // in the middle of comparing.
    const selection = selectionOf([done('r3', 3, 'c.flac'), run('r1'), run('r2')]);
    expect(selection.candidates.map((candidate) => candidate.run)).toEqual(['r1', 'r2', 'r3']);
    expect(selection.candidates.map((candidate) => candidate.ordinal)).toEqual([1, 2, 3]);
  });

  it('selects the first ready candidate, so a partial result is auditionable at once', () => {
    // The spec calls this out explicitly: waiting for all N before anything can be heard is the behaviour
    // it is written against.
    const selection = selectionOf([run('r1'), done('r2', 2, 'b.flac'), run('r3')]);
    expect(selection.current?.run).toBe('r2');
    expect(selection.readyCount).toBe(1);
    expect(selection.pending).toBe(true);
  });

  it('keeps the caller´s candidate when it is still ready', () => {
    const runs = [done('r1', 1, 'a.flac'), done('r2', 2, 'b.flac'), run('r3')];
    expect(selectionOf(runs, 'r2').current?.run).toBe('r2');
  });

  it('moves off a candidate that stopped being ready', () => {
    // A run can fail after being selected. Remembering it would leave the picker showing a variant that no
    // longer exists.
    const runs = [done('r1', 1, 'a.flac'), run('r2', { status: 'failed', error: 'oom' }), run('r3')];
    expect(selectionOf(runs, 'r2').current?.run).toBe('r1');
  });

  it('does not treat a complete run with no output as ready', () => {
    const selection = selectionOf([run('r1', { status: 'complete' })]);
    expect(selection.current).toBeUndefined();
    expect(selection.candidates[0]?.ready).toBe(false);
  });

  it('ignores a run id the group lists but the queue does not have', () => {
    const selection = selectionOf([done('r1', 1, 'a.flac')]);
    expect(selection.totalCount).toBe(1);
  });

  it('reports exhaustion only once nothing can still arrive', () => {
    const failing = [
      run('r1', { status: 'failed' }),
      run('r2', { status: 'failed' }),
      run('r3', { status: 'running' }),
    ];
    expect(selectionOf(failing).exhausted).toBe(false);

    const allFailed = failing.map((entry) => ({ ...entry, status: 'failed' as const }));
    expect(selectionOf(allFailed).exhausted).toBe(true);
  });

  it('carries progress and stage through, so a pending candidate can show them', () => {
    const selection = selectionOf([run('r1', { status: 'running', progress: 0.4, stage: 'sampling' })]);
    expect(selection.candidates[0]).toMatchObject({ progress: 0.4, stage: 'sampling' });
  });
});

describe('choosing the output a clip is made from', () => {
  it('prefers the output the manifest declares', () => {
    // A graph may save a preview image beside its video; inserting the preview because it was listed first
    // would be a maddening bug.
    const video: GeneratorManifest = {
      ...manifest,
      produces: 'video',
      outputs: [{ key: 'video', type: 'video', node: '92' }],
    };
    const outputs = [
      { key: '80', type: 'image' as const, path: assetPath('generated/preview.png') },
      { key: '92', type: 'video' as const, path: assetPath('generated/take.mp4') },
    ];
    expect(primaryOutput(outputs, video)?.path).toBe('generated/take.mp4');
  });

  it('skips an optional declared output', () => {
    const withOptional: GeneratorManifest = {
      ...manifest,
      outputs: [
        { key: 'waveform', type: 'image', node: '80', optional: true },
        { key: 'audio', type: 'audio', node: '57' },
      ],
    };
    const outputs = [
      { key: '80', type: 'image' as const, path: assetPath('generated/wave.png') },
      { key: '57', type: 'audio' as const, path: assetPath('generated/bed.flac') },
    ];
    expect(primaryOutput(outputs, withOptional)?.key).toBe('57');
  });

  it('falls back to the produced type when the declaration matches nothing', () => {
    const outputs = [
      { key: 'x', type: 'image' as const, path: assetPath('generated/x.png') },
      { key: 'y', type: 'audio' as const, path: assetPath('generated/y.flac') },
    ];
    expect(primaryOutput(outputs, manifest)?.key).toBe('y');
  });

  it('returns nothing for a run with no outputs', () => {
    expect(primaryOutput([], manifest)).toBeUndefined();
  });
});

describe('stepping', () => {
  const three = [done('r1', 1, 'a.flac'), done('r2', 2, 'b.flac'), done('r3', 3, 'c.flac')];

  it('advances and wraps', () => {
    let selection = selectionOf(three);
    selection = stepSelection(selection, 1);
    expect(selection.current?.run).toBe('r2');
    selection = stepSelection(stepSelection(selection, 1), 1);
    expect(selection.current?.run).toBe('r1');
  });

  it('steps backwards past the start', () => {
    expect(stepSelection(selectionOf(three), -1).current?.run).toBe('r3');
  });

  it('walks only ready candidates', () => {
    // Stepping onto a variant that is still generating would show an empty frame and make the control feel
    // broken half the time.
    const mixed = [done('r1', 1, 'a.flac'), run('r2', { status: 'running' }), done('r3', 3, 'c.flac')];
    expect(stepSelection(selectionOf(mixed), 1).current?.run).toBe('r3');
  });

  it('returns the same selection when there is nothing to step to', () => {
    const one = selectionOf([done('r1', 1, 'a.flac'), run('r2')]);
    expect(stepSelection(one, 1)).toBe(one);

    const none = selectionOf([run('r1')]);
    expect(stepSelection(none, 1)).toBe(none);
  });
});

describe('selecting directly', () => {
  it('selects a ready candidate', () => {
    const selection = selectionOf([done('r1', 1, 'a.flac'), done('r2', 2, 'b.flac')]);
    expect(selectCandidate(selection, jobRunId('r2')).current?.run).toBe('r2');
  });

  it('ignores a candidate that is not ready', () => {
    const selection = selectionOf([done('r1', 1, 'a.flac'), run('r2', { status: 'running' })]);
    expect(selectCandidate(selection, jobRunId('r2'))).toBe(selection);
  });
});

describe('outcomes', () => {
  it('describes what to insert, rather than inserting it', () => {
    // Keeping this a value is what lets the whole interaction be undone as one patch, and tested with no
    // document at all.
    const selection = selectionOf([done('r1', 4471, 'a.flac')]);
    expect(acceptSelection(selection)).toEqual({
      kind: 'accept',
      group: group.id,
      run: 'r1',
      seed: 4471,
      output: { key: '57', type: 'audio', path: 'generated/a.flac' },
      target: group.target,
    });
  });

  it('cannot accept when nothing is ready', () => {
    expect(acceptSelection(selectionOf([run('r1')]))).toBeUndefined();
  });

  it('discarding names the group and nothing else', () => {
    // The spec keeps unaccepted variants in `generated/`; an outcome that carried file paths would invite a
    // caller to delete them.
    expect(discardSelection(selectionOf([done('r1', 1, 'a.flac')]))).toEqual({
      kind: 'discard',
      group: group.id,
    });
  });
});

describe('describeSelection', () => {
  it('reads as a position once everything has arrived', () => {
    const all = [done('r1', 1, 'a.flac'), done('r2', 2, 'b.flac')];
    expect(describeSelection(selectionOf(all, 'r2'))).toBe('2 / 2');
  });

  it('says how many are still coming', () => {
    const partial = [done('r1', 1, 'a.flac'), run('r2', { status: 'running' }), run('r3')];
    expect(describeSelection(selectionOf(partial))).toBe('1 / 3 · 2 still generating');
  });

  it('says so before the first result', () => {
    expect(describeSelection(selectionOf([run('r1'), run('r2'), run('r3')]))).toBe(
      'generating 3 variants',
    );
  });

  it('says so when every variant failed', () => {
    const failed = [run('r1', { status: 'failed' }), run('r2', { status: 'failed' })];
    expect(describeSelection(selectionOf(failed))).toBe('every variant failed');
  });
});

describe('placeholder length', () => {
  const rate = FRAME_RATES.WEB_30;

  it('sizes a declared manifest from its length parameter', () => {
    const length = placeholderLength({ manifest, params: { duration_s: 4 }, frameRate: rate });
    expect(length).toEqual({ frames: frameCount(120), known: true });
  });

  it('uses the declared default when the user set nothing', () => {
    const length = placeholderLength({ manifest, params: { duration_s: 50 }, frameRate: rate });
    expect(length.frames).toBe(1500);
  });

  it('rounds up, so a placeholder is never shorter than its output', () => {
    // A short placeholder would let a neighbour sit where the real clip needs to be, and correcting it
    // would then have to move someone else's edit.
    const length = placeholderLength({ manifest, params: { duration_s: 1.01 }, frameRate: rate });
    expect(length.frames).toBe(31);
  });

  it('honours an explicit declaration over the key convention', () => {
    const explicit: GeneratorManifest = {
      ...manifest,
      durationFrom: { param: 'frames', unit: 'frames' },
      params: [...manifest.params, { key: 'frames', type: 'int', bind: '/f' }],
    };
    const length = placeholderLength({
      manifest: explicit,
      params: { frames: 90, duration_s: 50 },
      frameRate: rate,
    });
    expect(length.frames).toBe(90);
  });

  it('ignores a declaration naming a parameter the manifest does not have', () => {
    // A stale declaration would otherwise size every placeholder from a missing value.
    const stale: GeneratorManifest = { ...manifest, durationFrom: { param: 'gone', unit: 'seconds' } };
    expect(placeholderLength({ manifest: stale, params: { duration_s: 4 }, frameRate: rate }).known).toBe(
      false,
    );
  });

  it('marks a discovered length as provisional rather than returning nothing', () => {
    // A zero-width placeholder would be unselectable and undroppable.
    const tts: GeneratorManifest = { ...manifest, duration: 'discovered' };
    const length = placeholderLength({ manifest: tts, params: {}, frameRate: rate });
    expect(length.known).toBe(false);
    expect(length.frames).toBeGreaterThan(0);
  });

  it('treats a missing or nonsensical value as unknown', () => {
    for (const value of [undefined, 0, -3, 'later']) {
      const params = value === undefined ? {} : { duration_s: value };
      expect(placeholderLength({ manifest, params, frameRate: rate }).known).toBe(false);
    }
  });

  it('takes a caller-supplied fallback', () => {
    const tts: GeneratorManifest = { ...manifest, duration: 'discovered' };
    const length = placeholderLength({
      manifest: tts,
      params: {},
      frameRate: rate,
      fallback: frameCount(45),
    });
    expect(length.frames).toBe(45);
  });
});
