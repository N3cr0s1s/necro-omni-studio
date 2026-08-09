import { describe, expect, it } from 'vitest';
import { type Clip, type VideoTrack, trackGaps } from './index.js';
import { assetPath, clipId, trackId } from './ids.js';
import { staticNumber } from './params.js';
import { FRAME_RATES } from '../time/frame-rate.js';
import { frameIndex } from '../time/frame-time.js';
import { spanFromBounds } from '../time/frame-span.js';

/**
 * Every gap on a track.
 *
 * The half of the frame-of-black report that matters more: a gap the user cannot see is one they will
 * not think to close, and at any working zoom one frame is a fraction of a pixel. This is what the
 * timeline draws a tick for.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function clip(id: string, from: number, to: number): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(from), frameIndex(to)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

function track(clips: readonly Clip[]): VideoTrack {
  return {
    kind: 'video',
    id: trackId('v1'),
    name: 'V1',
    muted: false,
    solo: false,
    locked: false,
    height: 84,
    collapsed: false,
    clips: clips as VideoTrack['clips'],
    transitions: [],
  };
}

describe('listing a track’s gaps', () => {
  it('reports each run of empty frames, with the clips on either side', () => {
    expect(trackGaps(track([clip('a', 0, 100), clip('b', 101, 200), clip('c', 260, 300)]))).toEqual([
      { start: 100, frames: 1, before: 'a', after: 'b' },
      { start: 200, frames: 60, before: 'b', after: 'c' },
    ]);
  });

  it('does not call the space before the first clip a gap', () => {
    // A sequence starting at frame forty is a decision about where the cut begins, not an accident
    // between two shots. Flagging it would warn on most projects.
    expect(trackGaps(track([clip('a', 40, 100)]))).toEqual([]);
  });

  it('reports nothing between clips that meet or overlap', () => {
    expect(trackGaps(track([clip('a', 0, 100), clip('b', 100, 200)]))).toEqual([]);
    expect(trackGaps(track([clip('a', 0, 120), clip('b', 100, 200)]))).toEqual([]);
  });

  it('finds no gap under a long clip that spans several short ones', () => {
    // The reach is the furthest any clip so far extends, not the last one read: `long` covers the
    // space between the two short clips, so there is nothing empty there.
    expect(
      trackGaps(
        track([clip('long', 0, 300), clip('x', 10, 20), clip('y', 100, 110), clip('after', 400, 500)]),
      ),
    ).toEqual([{ start: 300, frames: 100, before: 'long', after: 'after' }]);
  });

  it('reads clips in timeline order whatever order they are stored in', () => {
    const gaps = trackGaps(track([clip('c', 260, 300), clip('a', 0, 100), clip('b', 101, 200)]));
    expect(gaps.map((gap) => gap.start)).toEqual([100, 200]);
  });

  it('is empty for an empty track', () => {
    expect(trackGaps(track([]))).toEqual([]);
  });
});
