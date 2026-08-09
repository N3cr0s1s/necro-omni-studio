import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type TimelineDocument,
  type Track,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  endExclusive,
  frameIndex,
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { closeAllGaps, closeGapBefore, gapBefore } from './close-gap.js';

/**
 * Closing a gap.
 *
 * The frame of black nobody can see and everybody delivers. Snapping stops it happening again; this is
 * for the ones already there, and the property worth protecting is that it never *adds* material —
 * closing a gap must move a clip, never stretch its neighbour.
 */

const V1 = trackId('v1');
const A1 = trackId('a1');

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, from: number, to: number, extra: Partial<Clip> = {}): Clip {
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
    ...extra,
  } as Clip;
}

function audio(id: string, from: number, to: number, extra: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(from), frameIndex(to)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.wav'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...extra,
  } as AudioClip;
}

function documentWith(v1: readonly Clip[], a1: readonly AudioClip[] = [], lock?: string): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: V1, audio: A1, text: trackId('t1') },
  });

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) => {
        const locked = track.id === lock;
        if (track.id === V1) return { ...track, clips: v1, locked } as Track;
        if (track.id === A1) return { ...track, clips: a1, locked } as Track;
        return { ...track, locked } as Track;
      }),
    },
  };
}

const spanOf = (document: TimelineDocument, id: string): readonly [number, number] => {
  const located = locateClip(document, clipId(id));
  if (located === undefined) throw new Error(`no clip ${id}`);
  return [located.clip.span.start, endExclusive(located.clip.span)];
};

describe('finding a gap', () => {
  it('measures the distance to the nearest clip that ends before this one starts', () => {
    const document = documentWith([video('a', 0, 100), video('b', 101, 200)]);
    expect(gapBefore(document, clipId('b'))).toEqual({ track: V1, previous: 'a', frames: 1 });
  });

  it('measures back to frame zero when nothing precedes it', () => {
    const document = documentWith([video('a', 40, 100)]);
    expect(gapBefore(document, clipId('a'))).toEqual({ track: V1, frames: 40 });
  });

  it('is nothing when the clips already meet', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    expect(gapBefore(document, clipId('b'))).toBeUndefined();
  });

  it('is nothing when the clips overlap, which is a crossfade rather than a gap', () => {
    const document = documentWith([video('a', 0, 120), video('b', 100, 200)]);
    expect(gapBefore(document, clipId('b'))).toBeUndefined();
  });

  it('measures to the *nearest* end, not to whichever clip was found first', () => {
    // Two clips before it, and the answer is the later one. Reading the array in order would report
    // the gap back to `a` and close it by far too much.
    const document = documentWith([video('a', 0, 40), video('far', 300, 400), video('b', 200, 260)]);
    expect(gapBefore(document, clipId('b'))?.previous).toBe('a');
    expect(gapBefore(document, clipId('b'))?.frames).toBe(160);
  });

  it('is nothing on a locked track', () => {
    const document = documentWith([video('a', 0, 100), video('b', 150, 200)], [], V1);
    expect(gapBefore(document, clipId('b'))).toBeUndefined();
  });
});

describe('closing it', () => {
  it('moves the clip back to meet its neighbour, and never stretches the neighbour', () => {
    const document = documentWith([video('a', 0, 100), video('b', 101, 200)]);
    const result = closeGapBefore(document, clipId('b'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'b')).toEqual([100, 199]);
    // The whole point: a command named for removing a gap must not add material nobody asked to see.
    expect(spanOf(result.value, 'a')).toEqual([0, 100]);
  });

  it('takes a linked pair with it', () => {
    const document = documentWith(
      [video('va', 0, 100), video('vb', 140, 200, { linkedAudio: clipId('ab') } as Partial<Clip>)],
      [audio('aa', 0, 100), audio('ab', 140, 200, { linkedVideo: clipId('vb') })],
    );
    const result = closeGapBefore(document, clipId('vb'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'vb')).toEqual([100, 160]);
    expect(spanOf(result.value, 'ab')).toEqual([100, 160]);
  });

  it('refuses whole when the pair cannot move together', () => {
    // The sound's own neighbour is in the way. A picture that closed its gap while its sound stayed
    // put is the desynchronization the linked trim exists to prevent.
    const document = documentWith(
      [video('va', 0, 100), video('vb', 140, 200, { linkedAudio: clipId('ab') } as Partial<Clip>)],
      [audio('aa', 0, 130), audio('ab', 140, 200, { linkedVideo: clipId('vb') })],
    );
    const result = closeGapBefore(document, clipId('vb'));
    expect(result.ok).toBe(false);
  });

  it('is a no-op when there is nothing to close, so pressing it twice is safe', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    const result = closeGapBefore(document, clipId('b'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(document);
  });

  it('pulls a clip back to frame zero when nothing precedes it', () => {
    const document = documentWith([video('a', 40, 100)]);
    const result = closeGapBefore(document, clipId('a'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'a')).toEqual([0, 60]);
  });
});

describe('closing a whole track', () => {
  it('closes every gap, left to right', () => {
    const document = documentWith([video('a', 10, 100), video('b', 150, 200), video('c', 260, 300)]);
    const result = closeAllGaps(document, V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'a')).toEqual([0, 90]);
    expect(spanOf(result.value, 'b')).toEqual([90, 140]);
    expect(spanOf(result.value, 'c')).toEqual([140, 180]);
  });

  it('re-reads after each move, since closing one gap moves the next clip’s neighbour', () => {
    // A list of deltas computed once would close the second gap to a position that no longer exists,
    // leaving `c` overlapping `b` or short of it.
    const document = documentWith([video('a', 100, 200), video('b', 300, 400)]);
    const result = closeAllGaps(document, V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'b')).toEqual([100, 200]);
  });

  it('steps over a clip that cannot move rather than failing the pass', () => {
    // Closing four of five gaps is worth more than closing none.
    const document = documentWith(
      [video('a', 10, 100), video('b', 150, 200, { linkedAudio: clipId('stuck') } as Partial<Clip>)],
      [audio('blocker', 0, 200), audio('stuck', 200, 260, { linkedVideo: clipId('b') })],
    );
    const result = closeAllGaps(document, V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'a')).toEqual([0, 90]);
    expect(spanOf(result.value, 'b')).toEqual([150, 200]);
  });

  it('refuses a locked track', () => {
    const document = documentWith([video('a', 10, 100)], [], V1);
    const result = closeAllGaps(document, V1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('track-locked');
  });
});
