import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type TimelineDocument,
  type Track,
  FRAME_RATES,
  assetPath,
  clipFade,
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
import type { SourceBoundsResolver } from './clip-ops.js';
import { crossfadeAtCut, cutPairFor, maxCrossfadeAtCut } from './crossfade-at-cut.js';

/**
 * A crossfade made at a cut.
 *
 * The half of issue #38 a keyboard reaches, and the one that keeps the sequence's length: the clips
 * grow into the material beyond their edges rather than sliding over each other. A pair of *sounds*
 * meeting at a cut had no way at all to be crossfaded before this, because transitions are a video
 * track's feature.
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

function video(id: string, from: number, to: number, sourceIn = 100): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(from), frameIndex(to)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath('media/a.mp4'),
      sourceIn: frameIndex(sourceIn),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform,
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

function audio(id: string, from: number, to: number, sourceIn = 100): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(from), frameIndex(to)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath('media/a.wav'),
      sourceIn: frameIndex(sourceIn),
      sourceRate: FRAME_RATES.WEB_30,
    },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
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

const fadeOf = (document: TimelineDocument, id: string) => {
  const located = locateClip(document, clipId(id));
  if (located === undefined) throw new Error(`no clip ${id}`);
  return clipFade(located.clip);
};

const sourceInOf = (document: TimelineDocument, id: string): number => {
  const located = locateClip(document, clipId(id));
  if (located === undefined || located.clip.kind === 'text') throw new Error(`no source for ${id}`);
  return located.clip.source.sourceIn;
};

/** 200 frames of material behind every clip, so handles exist on both sides. */
const sources: SourceBoundsResolver = { boundsFor: () => ({ totalFrames: 400 }) };

describe('finding the cut', () => {
  it('reads the clip’s own out-point by default', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    expect(cutPairFor(document, clipId('a'))).toEqual({ outgoing: 'a', incoming: 'b' });
  });

  it('reads leftwards when asked', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    expect(cutPairFor(document, clipId('b'), 'before')).toEqual({ outgoing: 'a', incoming: 'b' });
  });

  it('is nothing where there is no neighbour', () => {
    const document = documentWith([video('a', 0, 100)]);
    expect(cutPairFor(document, clipId('a'))).toBeUndefined();
  });
});

describe('making one', () => {
  const pair = () => documentWith([video('a', 0, 100), video('b', 100, 200)]);

  it('grows each clip into its own handle, keeping the sequence’s length', () => {
    const result = crossfadeAtCut({ document: pair(), clip: clipId('a'), frames: 20, options: { sources } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Ten frames each way, so the pair now overlaps by twenty and still ends where it did.
    expect(spanOf(result.value, 'a')).toEqual([0, 110]);
    expect(spanOf(result.value, 'b')).toEqual([90, 200]);
    // The incoming clip's material moves back with its edge, or the overlap would show frames it
    // already played.
    expect(sourceInOf(result.value, 'b')).toBe(90);
  });

  it('ramps only the arriving picture', () => {
    const result = crossfadeAtCut({ document: pair(), clip: clipId('a'), frames: 20, options: { sources } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fadeOf(result.value, 'b').inFrames).toBe(20);
    expect(fadeOf(result.value, 'a').outFrames).toBe(0);
  });

  it('ramps both sounds, which is what a pair of takes had no way to do at all', () => {
    const document = documentWith([], [audio('a', 0, 100), audio('b', 100, 200)]);
    const result = crossfadeAtCut({ document, clip: clipId('a'), frames: 20, options: { sources } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fadeOf(result.value, 'a').outFrames).toBe(20);
    expect(fadeOf(result.value, 'b').inFrames).toBe(20);
  });

  it('splits an odd length so the whole of it is used', () => {
    const result = crossfadeAtCut({ document: pair(), clip: clipId('a'), frames: 21, options: { sources } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'a')[1] - spanOf(result.value, 'b')[0]).toBe(21);
  });

  it('refuses whole when one side has no handle, rather than growing the other', () => {
    // `b` starts at source frame 0, so there is nothing before its in-point to pull from. A clip that
    // silently grew here is more material than the user asked to see.
    const document = documentWith([video('a', 0, 100), video('b', 100, 200, 0)]);
    const result = crossfadeAtCut({ document, clip: clipId('a'), frames: 20, options: { sources } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('source-exhausted');
  });

  it('refuses across a gap, which is a different edit with a different name', () => {
    const document = documentWith([video('a', 0, 100), video('b', 120, 200)]);
    const result = crossfadeAtCut({ document, clip: clipId('a'), frames: 20, options: { sources } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-shared-cut');
  });

  it('refuses to consume a clip whole', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 110)]);
    const result = crossfadeAtCut({ document, clip: clipId('a'), frames: 20, options: { sources } });
    expect(result.ok).toBe(false);
  });

  it('refuses on a locked track', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)], [], V1);
    const result = crossfadeAtCut({ document, clip: clipId('a'), frames: 20, options: { sources } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('track-locked');
  });

  it('proceeds unchecked when nothing knows how long the source is', () => {
    // The same rule a tail trim follows: editing is never blocked waiting on a probe.
    const result = crossfadeAtCut({ document: pair(), clip: clipId('a'), frames: 20 });
    expect(result.ok).toBe(true);
  });
});

describe('how long a cut can carry', () => {
  it('is twice the scarcer handle', () => {
    // `b` has 40 frames before its in-point and the source leaves 100 beyond `a`, so the fade is
    // limited to 80 — twice the smaller half.
    const document = documentWith([video('a', 0, 100), video('b', 100, 200, 40)]);
    const limited: SourceBoundsResolver = { boundsFor: () => ({ totalFrames: 300 }) };
    expect(maxCrossfadeAtCut(document, clipId('a'), 'after', { sources: limited })).toBe(80);
  });

  it('never exceeds the shorter clip', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 130)]);
    expect(maxCrossfadeAtCut(document, clipId('a'), 'after', { sources })).toBe(29);
  });

  it('is nothing where there is no cut', () => {
    expect(maxCrossfadeAtCut(documentWith([video('a', 0, 100)]), clipId('a'))).toBe(0);
  });
});
