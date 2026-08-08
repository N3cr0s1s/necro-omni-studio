import { describe, expect, it } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type VideoTrack,
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
import { clampRoll, clipBefore, rollEdit, rollRange, rollTo, sharedCut } from './roll-edit.js';

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

/** `sourceIn` is generous by default, so handles exist on both sides of every cut. */
function video(id: string, start: number, end: number, sourceIn = 1000): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(sourceIn),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform,
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

function documentWith(clips: readonly Clip[], secondTrack: readonly Clip[] = []): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
  const v1 = base.sequence.tracks.find((track) => track.kind === 'video') as VideoTrack;

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: [
        { ...v1, clips: clips as VideoTrack['clips'] },
        { ...v1, id: trackId('v2'), name: 'V2', clips: secondTrack as VideoTrack['clips'] },
        ...base.sequence.tracks.filter((track) => track.kind !== 'video'),
      ],
    },
  };
}

const span = (document: TimelineDocument, clip: string) => {
  const found = locateClip(document, clipId(clip));
  return found === undefined
    ? undefined
    : { start: found.clip.span.start as number, end: endExclusive(found.clip.span) as number };
};

/** Two flush clips: `a` covers 0–100, `b` covers 100–200. */
const flush = () => documentWith([video('a', 0, 100), video('b', 100, 200)]);

const roll = (document: TimelineDocument, delta: number) =>
  rollEdit({ document, outgoing: clipId('a'), incoming: clipId('b'), delta });

describe('finding the cut', () => {
  it('is the frame where one clip ends and the next begins', () => {
    expect(sharedCut(flush(), clipId('a'), clipId('b'))?.frame).toBe(100);
  });

  it('is nothing when there is a gap between them', () => {
    // Rolling across a gap would silently close it. That is a ripple — a different edit.
    const gapped = documentWith([video('a', 0, 100), video('b', 150, 250)]);
    expect(sharedCut(gapped, clipId('a'), clipId('b'))).toBeUndefined();
  });

  it('is nothing when they are on different tracks', () => {
    const split = documentWith([video('a', 0, 100)], [video('b', 100, 200)]);
    expect(sharedCut(split, clipId('a'), clipId('b'))).toBeUndefined();
  });

  it('is nothing when the clips are given the wrong way round', () => {
    // `b` does not end where `a` begins, so this is not their cut — reversing the arguments must not
    // quietly roll the boundary in the opposite direction.
    expect(sharedCut(flush(), clipId('b'), clipId('a'))).toBeUndefined();
  });

  it('finds the clip before a given one', () => {
    expect(clipBefore(flush(), clipId('b'))).toBe('a');
    expect(clipBefore(flush(), clipId('a'))).toBeUndefined();
  });
});

describe('rolling the cut', () => {
  it('moves it later, and the two edges stay flush', () => {
    const result = roll(flush(), 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(span(result.value, 'a')).toEqual({ start: 0, end: 120 });
    expect(span(result.value, 'b')).toEqual({ start: 120, end: 200 });
  });

  it('moves it earlier, and the two edges stay flush', () => {
    const result = roll(flush(), -30);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(span(result.value, 'a')).toEqual({ start: 0, end: 70 });
    expect(span(result.value, 'b')).toEqual({ start: 70, end: 200 });
  });

  it('never changes the sequence’s length', () => {
    // The property that makes it a roll rather than two trims: one clip gains exactly what the other
    // gives up, so nothing downstream moves.
    for (const delta of [-40, -1, 1, 40]) {
      const result = roll(flush(), delta);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(span(result.value, 'a')?.start).toBe(0);
      expect(span(result.value, 'b')?.end).toBe(200);
    }
  });

  it('advances the incoming clip’s in-point, so its content does not slide', () => {
    // Rolling right shows more of the outgoing clip and *less* of the incoming one — its first frame
    // must move forward by the same amount, or the roll would behave like a slip.
    const result = roll(flush(), 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const incoming = locateClip(result.value, clipId('b'));
    expect(incoming?.clip.kind === 'video' && incoming.clip.source.sourceIn).toBe(1020);
  });

  it('does nothing for a delta of zero', () => {
    const document = flush();
    const result = roll(document, 0);
    expect(result.ok && result.value).toBe(document);
  });

  it('refuses when the clips do not meet, and says so', () => {
    const gapped = documentWith([video('a', 0, 100), video('b', 150, 250)]);
    const result = roll(gapped, 10);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('no-shared-cut');
  });

  it('refuses rather than rolling one edge and not the other', () => {
    // Whole or nothing. `b` has only 20 frames of head material, so rolling left by 40 would shorten
    // `a` and then fail to lengthen `b` — leaving exactly the gap this operation prevents.
    const tight = documentWith([video('a', 0, 100), video('b', 100, 200, 20)]);
    const result = rollEdit({
      document: tight,
      outgoing: clipId('a'),
      incoming: clipId('b'),
      delta: -40,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('source-exhausted');
  });

  it('leaves the document untouched when it refuses', () => {
    const tight = documentWith([video('a', 0, 100), video('b', 100, 200, 20)]);
    const before = span(tight, 'a');
    rollEdit({ document: tight, outgoing: clipId('a'), incoming: clipId('b'), delta: -40 });
    expect(span(tight, 'a')).toEqual(before);
  });

  it('refuses to roll a clip out of existence', () => {
    const result = roll(flush(), -100);
    expect(result.ok).toBe(false);
  });
});

describe('how far the cut may move', () => {
  it('is bounded by each side keeping at least one frame', () => {
    // A clip rolled to nothing would be deleted by an edit whose name says it moves a boundary.
    expect(rollRange(flush(), clipId('a'), clipId('b'))).toEqual({ earliest: 99, latest: 99 });
  });

  it('is nothing at all when the clips do not meet', () => {
    const gapped = documentWith([video('a', 0, 100), video('b', 150, 250)]);
    expect(rollRange(gapped, clipId('a'), clipId('b'))).toEqual({ earliest: 0, latest: 0 });
  });

  it('clamps a wanted delta to what the spans allow', () => {
    // So a drag can be limited to what is legal rather than discovering it by being refused.
    const document = flush();
    expect(clampRoll(document, clipId('a'), clipId('b'), 500)).toBe(99);
    expect(clampRoll(document, clipId('a'), clipId('b'), -500)).toBe(-99);
    expect(clampRoll(document, clipId('a'), clipId('b'), 12)).toBe(12);
  });
});

describe('rolling to a frame', () => {
  it('moves the cut to where it was asked to be', () => {
    const result = rollTo(flush(), clipId('a'), clipId('b'), 130);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(span(result.value, 'a')?.end).toBe(130);
    expect(span(result.value, 'b')?.start).toBe(130);
  });

  it('never asks for a negative frame', () => {
    const result = rollTo(flush(), clipId('a'), clipId('b'), -50);
    // Refused because it would empty `a`, not because the arithmetic went negative.
    expect(result.ok).toBe(false);
  });
});
