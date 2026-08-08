import { describe, expect, it } from 'vitest';
import { type AssetPath, assetPath, clipId, err, frameIndex, ok, spanFromBounds } from '@nos/core';
import type { MaskFrame, MaskPrompt, MaskTrack } from '../contracts/mask.js';
import { describeTrack, emptyTrack, maskTrackId, promptsAt, withPrompt, withoutPrompt } from '../contracts/mask.js';
import type { SegmentationEvent } from '../contracts/segmenter.js';
import {
  addPrompt,
  applyEvent,
  beginRun,
  beginSession,
  coverage,
  coveredSpans,
  describeSession,
  maskAt,
  moveTo,
  removePrompt,
  setPropagation,
  toRequest,
} from './mask-session.js';

const range = spanFromBounds(frameIndex(100), frameIndex(200));
const track = (): MaskTrack => emptyTrack(maskTrackId('m1'), clipId('c1'), range);
const source: AssetPath = assetPath('media/shot.mp4');

const point = (frame: number, include = true): MaskPrompt => ({
  kind: 'point',
  frame: frameIndex(frame),
  x: 0.5,
  y: 0.5,
  include,
});

const mask = (frame: number): MaskFrame => ({
  frame: frameIndex(frame),
  width: 4,
  height: 2,
  counts: [0, 8],
});

const session = () => beginSession(track(), frameIndex(120));

describe('prompts', () => {
  it('records a click', () => {
    const after = addPrompt(session(), point(120));
    expect(after.track.prompts).toHaveLength(1);
  });

  it('keeps negative clicks distinct, since they are what separate an object from its background', () => {
    const after = addPrompt(addPrompt(session(), point(120)), point(120, false));
    expect(after.track.prompts.map((prompt) => prompt.kind === 'point' && prompt.include)).toEqual([
      true,
      false,
    ]);
  });

  it('marks a ready mask stale rather than re-running, since propagation is expensive', () => {
    // Auto-running on every click would make the feature unusable on a long clip.
    const ready: MaskTrack = { ...track(), status: 'ready' };
    expect(withPrompt(ready, point(120)).status).toBe('stale');
  });

  it('returns to empty when the last prompt is removed', () => {
    const one = withPrompt(track(), point(120));
    expect(withoutPrompt(one, 0).status).toBe('empty');
  });

  it('ignores a removal that names nothing', () => {
    const one = addPrompt(session(), point(120));
    expect(removePrompt(one, 5)).toBe(one);
  });

  it('reports the prompts on one frame, which is what an engine is given first', () => {
    const both = withPrompt(withPrompt(track(), point(120)), point(150));
    expect(promptsAt(both, frameIndex(120))).toHaveLength(1);
  });
});

describe('the propagation range', () => {
  it('starts as the clip´s range', () => {
    expect(session().propagation).toEqual(range);
  });

  it('narrows', () => {
    const narrowed = setPropagation(session(), spanFromBounds(frameIndex(120), frameIndex(160)));
    expect(narrowed.propagation).toEqual(spanFromBounds(frameIndex(120), frameIndex(160)));
  });

  it('clamps to the clip, because masks outside it are pure cost', () => {
    const wide = setPropagation(session(), spanFromBounds(frameIndex(0), frameIndex(1000)));
    expect(wide.propagation).toEqual(range);
  });

  it('ignores a range that misses the clip entirely', () => {
    const before = session();
    expect(setPropagation(before, spanFromBounds(frameIndex(0), frameIndex(50)))).toBe(before);
  });
});

describe('the engine request', () => {
  it('carries the prompts and the narrowed range', () => {
    const ready = setPropagation(addPrompt(session(), point(120)), spanFromBounds(frameIndex(110), frameIndex(150)));
    expect(toRequest(ready, source)).toMatchObject({
      source,
      range: spanFromBounds(frameIndex(110), frameIndex(150)),
      prompts: [expect.objectContaining({ frame: 120 })],
    });
  });

  it('is undefined before anything is clicked, since an engine cannot guess the subject', () => {
    expect(toRequest(session(), source)).toBeUndefined();
  });
});

describe('folding engine events', () => {
  const running = () => beginRun(addPrompt(session(), point(120)));

  it('reveals each frame as it arrives', () => {
    // Watching a propagation fill in is what tells the user it is tracking the right object; waiting for
    // all 500 frames to find out is the behaviour this is written against.
    const after = applyEvent(running(), { kind: 'frame', mask: mask(120) });
    expect(maskAt(after, frameIndex(120))).toBeDefined();
  });

  it('tracks progress', () => {
    const after = applyEvent(running(), { kind: 'progress', progress: { fraction: 0.4 } });
    expect(after.progress).toBe(0.4);
  });

  it('marks the track ready when the run succeeds', () => {
    const done: SegmentationEvent = {
      kind: 'done',
      result: ok({ frames: 100, width: 4, height: 2 }),
    };
    const after = applyEvent(running(), done);
    expect(after.track.status).toBe('ready');
    expect(after.running).toBe(false);
  });

  it('keeps partial results when the run fails', () => {
    // 300 frames of a 500-frame propagation is 300 frames of expensive work; discarding them because the
    // run did not finish would be the worst possible response to a failure.
    const partial = applyEvent(running(), { kind: 'frame', mask: mask(120) });
    const after = applyEvent(partial, { kind: 'done', result: err({ kind: 'failed', detail: 'OOM' }) });

    expect(after.frames.size).toBe(1);
    expect(after.track.status).toBe('stale');
    expect(after.error).toBe('OOM');
  });

  it('fails outright when nothing arrived', () => {
    const after = applyEvent(running(), { kind: 'done', result: err({ kind: 'failed', detail: 'OOM' }) });
    expect(after.track.status).toBe('failed');
  });

  it('explains an unavailable engine rather than reporting a generic failure', () => {
    const after = applyEvent(running(), {
      kind: 'done',
      result: err({ kind: 'unavailable', detail: 'sam2 is not installed' }),
    });
    expect(after.error).toContain('sam2 is not installed');
  });

  it('clears the previous error on a re-run but keeps its frames', () => {
    const failed = applyEvent(
      applyEvent(running(), { kind: 'frame', mask: mask(120) }),
      { kind: 'done', result: err({ kind: 'cancelled' }) },
    );
    const again = beginRun(failed);

    expect(again.error).toBeUndefined();
    expect(again.frames.size).toBe(1);
  });
});

describe('coverage', () => {
  const withFrames = (frames: readonly number[]) =>
    frames.reduce<ReturnType<typeof session>>(
      (current, frame) => applyEvent(current, { kind: 'frame', mask: mask(frame) }),
      session(),
    );

  it('reports the fraction of the range that has a mask', () => {
    expect(coverage(withFrames([100, 101]))).toBeCloseTo(0.02, 6);
  });

  it('ignores frames outside the propagation range', () => {
    expect(coverage(withFrames([50, 100]))).toBeCloseTo(0.01, 6);
  });

  it('groups contiguous frames into spans, for the range bar', () => {
    const spans = coveredSpans(withFrames([100, 101, 102, 110, 111]));
    expect(spans).toEqual([
      spanFromBounds(frameIndex(100), frameIndex(103)),
      spanFromBounds(frameIndex(110), frameIndex(112)),
    ]);
  });

  it('reports a single frame as a one-frame span', () => {
    expect(coveredSpans(withFrames([120]))).toEqual([spanFromBounds(frameIndex(120), frameIndex(121))]);
  });

  it('reports nothing before any frame arrives', () => {
    expect(coveredSpans(session())).toEqual([]);
    expect(coverage(session())).toBe(0);
  });
});

describe('descriptions', () => {
  it('says what to do first', () => {
    expect(describeSession(session())).toBe('click the object to start');
    expect(describeTrack(track())).toBe('click the object to start');
  });

  it('says a run is ready to start', () => {
    expect(describeSession(addPrompt(session(), point(120)))).toBe('ready to segment');
  });

  it('shows progress while running', () => {
    const running = applyEvent(beginRun(addPrompt(session(), point(120))), {
      kind: 'progress',
      progress: { fraction: 0.42 },
    });
    expect(describeSession(running)).toBe('segmenting 42%');
  });

  it('says the prompts changed, rather than silently showing an old mask', () => {
    const ready: MaskTrack = { ...track(), status: 'ready', prompts: [point(120)] };
    expect(describeTrack(withPrompt(ready, point(130)))).toBe('prompts changed — re-run to update');
  });

  it('counts the masked frames when a run finished', () => {
    const done = applyEvent(
      applyEvent(beginRun(addPrompt(session(), point(120))), { kind: 'frame', mask: mask(120) }),
      { kind: 'done', result: ok({ frames: 1, width: 4, height: 2 }) },
    );
    expect(describeSession(done)).toBe('1 frames masked');
  });
});

describe('navigation', () => {
  it('moves the current frame', () => {
    expect(moveTo(session(), frameIndex(150)).frame).toBe(150);
  });

  it('returns the same session when nothing moved', () => {
    const before = session();
    expect(moveTo(before, before.frame)).toBe(before);
  });
});
