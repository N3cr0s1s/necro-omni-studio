import { describe, expect, it } from 'vitest';
import {
  type TimelineDocument,
  type VideoClip,
  type VideoTrack,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import {
  DEFAULT_SNAP_PIXELS,
  type SnapCandidate,
  collectSnapCandidates,
  snapEdgeDelta,
  snapFrame,
  snapSpanTranslation,
  snapThresholdFrames,
} from './snap.js';

const V1 = trackId('v1');

function videoClip(id: string, start: number, end: number): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
  } as VideoClip;
}

function makeDocument(clips: readonly VideoClip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: V1, audio: trackId('a1'), text: trackId('t1') },
  });
  const v1: VideoTrack = { ...(base.sequence.tracks[0] as VideoTrack), clips };
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: [v1, ...base.sequence.tracks.slice(1)],
      markers: [{ frame: frameIndex(500), label: 'beat' }],
      workRange: spanFromBounds(frameIndex(900), frameIndex(1400)),
    },
  };
}

const candidate = (frame: number, kind: SnapCandidate['kind'] = 'clip-start'): SnapCandidate => ({
  frame: frameIndex(frame),
  kind,
});

describe('collectSnapCandidates', () => {
  it('always includes the origin, so an empty track still has a target', () => {
    const document = makeDocument([]);
    const candidates = collectSnapCandidates(document, frameIndex(42));
    expect(candidates.some((entry) => entry.kind === 'origin' && entry.frame === 0)).toBe(true);
  });

  it('includes the playhead', () => {
    const candidates = collectSnapCandidates(makeDocument([]), frameIndex(42));
    expect(candidates.some((entry) => entry.kind === 'playhead' && entry.frame === 42)).toBe(true);
  });

  it('includes both edges of every clip, tagged with its track', () => {
    const document = makeDocument([videoClip('a', 100, 200)]);
    const candidates = collectSnapCandidates(document, frameIndex(0));
    const starts = candidates.filter((entry) => entry.kind === 'clip-start');
    const ends = candidates.filter((entry) => entry.kind === 'clip-end');
    expect(starts.map((entry) => entry.frame)).toContain(100);
    expect(ends.map((entry) => entry.frame)).toContain(200);
    expect(starts[0]?.track).toBe(V1);
  });

  it('includes markers and both work-range edges', () => {
    const candidates = collectSnapCandidates(makeDocument([]), frameIndex(0));
    expect(candidates.filter((entry) => entry.kind === 'marker').map((e) => e.frame)).toEqual([500]);
    expect(candidates.filter((entry) => entry.kind === 'work-range').map((e) => e.frame)).toEqual([
      900, 1400,
    ]);
  });

  it('excludes the dragged clip, so it cannot snap to its own edges', () => {
    const document = makeDocument([videoClip('a', 100, 200), videoClip('b', 300, 400)]);
    const candidates = collectSnapCandidates(document, frameIndex(0), { ignoreClips: ['a'] });
    const frames = candidates.map((entry) => entry.frame);
    expect(frames).not.toContain(100);
    expect(frames).not.toContain(200);
    expect(frames).toContain(300);
  });

  it('can be restricted to specific tracks', () => {
    const document = makeDocument([videoClip('a', 100, 200)]);
    const candidates = collectSnapCandidates(document, frameIndex(0), {
      tracks: [trackId('a1')],
    });
    expect(candidates.some((entry) => entry.kind === 'clip-start')).toBe(false);
  });
});

describe('snapFrame', () => {
  const candidates = [candidate(0, 'origin'), candidate(100), candidate(200)];

  it('snaps to a candidate inside the threshold', () => {
    const result = snapFrame(frameIndex(97), candidates, 5);
    expect(result.frame).toBe(100);
    expect(result.snappedTo?.frame).toBe(100);
  });

  it('leaves the frame alone when nothing is close enough', () => {
    const result = snapFrame(frameIndex(150), candidates, 5);
    expect(result.frame).toBe(150);
    expect(result.snappedTo).toBeUndefined();
  });

  it('snaps to the nearest of two candidates in range', () => {
    const result = snapFrame(frameIndex(104), [candidate(100), candidate(106)], 10);
    expect(result.frame).toBe(106);
  });

  it('resolves an exact tie deterministically, favouring the first candidate', () => {
    // The same gesture must always produce the same result; candidate order is stable.
    const result = snapFrame(frameIndex(105), [candidate(100), candidate(110)], 10);
    expect(result.frame).toBe(100);
  });

  it('includes a candidate exactly at the threshold', () => {
    expect(snapFrame(frameIndex(95), [candidate(100)], 5).frame).toBe(100);
    expect(snapFrame(frameIndex(94), [candidate(100)], 5).frame).toBe(94);
  });

  it('is disabled by a zero or negative threshold, which is how the override modifier works', () => {
    expect(snapFrame(frameIndex(99), candidates, 0).snappedTo).toBeUndefined();
    expect(snapFrame(frameIndex(99), candidates, -1).snappedTo).toBeUndefined();
  });

  it('handles an empty candidate list', () => {
    expect(snapFrame(frameIndex(42), [], 10)).toEqual({ frame: 42 });
  });
});

describe('snapSpanTranslation', () => {
  it('snaps by the start edge when it is closer', () => {
    const result = snapSpanTranslation(frameIndex(98), 50, [candidate(100)], 5);
    expect(result.frame).toBe(100);
  });

  it('snaps by the end edge, translating the whole span', () => {
    // A clip of 50 frames starting at 45 ends at 95; aligning that end to 100 puts the start at 50.
    const result = snapSpanTranslation(frameIndex(45), 50, [candidate(100)], 8);
    expect(result.frame).toBe(50);
    expect(result.snappedTo?.frame).toBe(100);
  });

  it('prefers the closer edge when both are in range', () => {
    // Start is 2 away from 100, end (at 130) is 5 away from 135 — the start wins.
    const result = snapSpanTranslation(frameIndex(98), 32, [candidate(100), candidate(135)], 10);
    expect(result.frame).toBe(100);
  });

  it('breaks an exact edge tie toward the start, the edge usually under the pointer', () => {
    // Start 98 is 2 from 100; end 148 is 2 from 150.
    const result = snapSpanTranslation(frameIndex(98), 50, [candidate(100), candidate(150)], 5);
    expect(result.frame).toBe(100);
  });

  it('leaves the span alone when neither edge is close enough', () => {
    const result = snapSpanTranslation(frameIndex(300), 50, [candidate(100)], 5);
    expect(result).toEqual({ frame: 300 });
  });

  it('preserves duration, landing the end exactly on the candidate', () => {
    const start = 45;
    const duration = 50;
    const result = snapSpanTranslation(frameIndex(start), duration, [candidate(100)], 8);
    // The end edge is what snapped, so it sits on the candidate and the length is unchanged.
    expect(result.frame + duration).toBe(100);
    expect(result.frame).toBe(50);
  });
});

describe('snapping a trimmed edge', () => {
  // A move snapped and a trim did not, which is how two clips end up looking adjacent while a single
  // black frame sits between them: the gap is one pixel wide at a working zoom and invisible until
  // the export is watched.
  it('lands the edge exactly on the candidate and reports the delta that gets it there', () => {
    const result = snapEdgeDelta(frameIndex(200), 7, [candidate(210)], 8);
    expect(result.delta).toBe(10);
    expect(result.snappedTo?.frame).toBe(210);
  });

  it('snaps backwards as readily as forwards', () => {
    const result = snapEdgeDelta(frameIndex(200), -7, [candidate(190)], 8);
    expect(result.delta).toBe(-10);
  });

  it('returns the requested delta untouched when nothing is in range', () => {
    expect(snapEdgeDelta(frameIndex(200), 7, [candidate(400)], 8)).toEqual({ delta: 7 });
  });

  it('can snap a trim that has not moved yet onto a neighbouring edge', () => {
    // Zero delta is not "no gesture" here: the pointer is down and one frame from a cut, and the edge
    // should still catch it.
    const result = snapEdgeDelta(frameIndex(199), 0, [candidate(200)], 8);
    expect(result.delta).toBe(1);
  });
});

describe('snapThresholdFrames', () => {
  it('scales the pixel threshold by the zoom level', () => {
    // The mockups show zoom as `4 f/px`; 8 px of tolerance is then 32 frames.
    expect(snapThresholdFrames(DEFAULT_SNAP_PIXELS, 4)).toBe(32);
  });

  it('never falls below one frame, so snapping still works fully zoomed in', () => {
    expect(snapThresholdFrames(DEFAULT_SNAP_PIXELS, 0.01)).toBe(1);
    expect(snapThresholdFrames(0, 1)).toBe(1);
  });

  it('rounds up, so a fractional threshold is reachable rather than unreachable', () => {
    expect(snapThresholdFrames(3, 0.5)).toBe(2);
  });
});
