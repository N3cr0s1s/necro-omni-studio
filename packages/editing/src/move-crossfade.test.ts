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
import { eligibleTracksFor } from './drag-target.js';
import { moveWithCrossfades, plannedCrossfades } from './move-crossfade.js';

/**
 * Dropping a clip onto its neighbour.
 *
 * The gesture the report named: laying two clips over each other should make a crossfade. What has to
 * hold is that the permission is *narrow* — everything the operation does not recognize as a
 * crossfade still refuses, so the timeline's rule against silently displacing material survives.
 */

const V1 = trackId('v1');
const A1 = trackId('a1');
const T1 = trackId('t1');

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

function documentWith(v1: readonly Clip[], a1: readonly AudioClip[] = []): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: V1, audio: A1, text: T1 },
  });

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) => {
        if (track.id === V1) return { ...track, clips: v1 } as Track;
        if (track.id === A1) return { ...track, clips: a1 } as Track;
        return track;
      }),
    },
  };
}

const request = (document: TimelineDocument, ids: readonly string[], deltaFrames: number, deltaRows = 0) => ({
  document,
  ids: ids.map(clipId),
  deltaFrames,
  deltaRows,
  eligibleTracks: (clip: Clip) => eligibleTracksFor(document.sequence.tracks, clip),
});

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

describe('dropping a clip onto its neighbour', () => {
  it('lets the clips overlap and writes the ramp, in one operation', () => {
    // The three things that had to agree: the move is permitted to overlap, the overlap is
    // recognized, and the ramps are written in the same step — so one undo takes all of it back.
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    const result = moveWithCrossfades(request(document, ['b'], -20));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(spanOf(result.value.document, 'b')).toEqual([80, 180]);
    expect(spanOf(result.value.document, 'a')).toEqual([0, 100]);
    expect(fadeOf(result.value.document, 'b')).toEqual({ inFrames: 20, outFrames: 0 });
    expect(result.value.crossfades).toHaveLength(1);
    expect(result.value.crossfades[0]!.outgoing).toBe('a');
  });

  it('makes one crossfade per medium when a linked pair lands on another', () => {
    // A user told "a crossfade was created" when two were is being told something false about their
    // own timeline, so the count is reported rather than a boolean.
    const document = documentWith(
      [video('va', 0, 100), video('vb', 100, 200)],
      [audio('aa', 0, 100), audio('ab', 100, 200)],
    );
    const result = moveWithCrossfades(request(document, ['vb', 'ab'], -20));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.crossfades).toHaveLength(2);
    // Picture: only the arriving clip ramps. Sound: both, because they sum.
    expect(fadeOf(result.value.document, 'vb').inFrames).toBe(20);
    expect(fadeOf(result.value.document, 'va').outFrames).toBe(0);
    expect(fadeOf(result.value.document, 'ab').inFrames).toBe(20);
    expect(fadeOf(result.value.document, 'aa').outFrames).toBe(20);
  });

  it('works dragging a clip backwards onto the shot in front of it', () => {
    // The mirror of the first case, and it was broken while that one passed: which clip is the
    // outgoing half depends on which *starts later*, so dropping a clip just before a stationary one
    // makes the moving clip the outgoing side — and a permission list keyed on `outgoing` named a
    // clip that was moving anyway, so every leftward dissolve was refused as a collision.
    const document = documentWith([video('a', 200, 300), video('b', 0, 100)]);
    const result = moveWithCrossfades(request(document, ['b'], 120));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(spanOf(result.value.document, 'b')).toEqual([120, 220]);
    expect(result.value.crossfades[0]).toMatchObject({ outgoing: 'b', incoming: 'a' });
    // `a` is the arriving picture even though `b` is the clip under the pointer.
    expect(fadeOf(result.value.document, 'a').inFrames).toBe(20);
    expect(fadeOf(result.value.document, 'b').outFrames).toBe(0);
  });

  it('is an ordinary move when nothing is overlapped', () => {
    const document = documentWith([video('a', 0, 100), video('b', 200, 300)]);
    const result = moveWithCrossfades(request(document, ['b'], -50));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value.document, 'b')).toEqual([150, 250]);
    expect(result.value.crossfades).toEqual([]);
    expect(locateClip(result.value.document, clipId('b'))!.clip.fade).toBeUndefined();
  });

  it('still refuses an overlap that is not a crossfade', () => {
    // Two clips touched at once: the caller clamps against it exactly as it always did, because
    // which of them is the outgoing side has no answer.
    const document = documentWith([video('a', 0, 100), video('b', 110, 150), video('c', 300, 420)]);
    const result = moveWithCrossfades(request(document, ['c'], -210));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('collision');
  });

  it('refuses to swallow a clip whole', () => {
    const document = documentWith([video('a', 100, 140), video('b', 200, 300)]);
    const result = moveWithCrossfades(request(document, ['b'], -110));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('collision');
  });

  it('does not read a clip closing up on another member of its own group as a crossfade', () => {
    // A translation preserves spacing, so two clips in the set overlap after the move exactly when
    // they did before it — blaming this move for that would fade a pair that never moved relative to
    // each other.
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    const result = moveWithCrossfades(request(document, ['a', 'b'], 50));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.crossfades).toEqual([]);
  });

  it('writes the ramp for where the clips actually landed, not where they were asked to go', () => {
    // A group meeting frame zero is clamped by its earliest member, so the whole set travels less far
    // than the pointer asked. The predicted overlap is then 70 frames and the real one 80, and a ramp
    // written from the prediction would leave ten frames of the dissolve at full opacity.
    const document = documentWith([video('a2', 230, 330), video('b', 300, 400)], [audio('m', 50, 150)]);
    const result = moveWithCrossfades(request(document, ['m', 'b'], -100));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Clamped to 50 by `m`, which cannot start before frame zero.
    expect(result.value.deltaFrames).toBe(-50);
    expect(spanOf(result.value.document, 'b')).toEqual([250, 350]);
    expect(fadeOf(result.value.document, 'b').inFrames).toBe(80);
  });
});

describe('predicting a crossfade before the drop', () => {
  it('is the same derivation the move uses, so a preview cannot disagree with its commit', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    const predicted = plannedCrossfades(request(document, ['b'], -20));
    const applied = moveWithCrossfades(request(document, ['b'], -20));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(predicted).toEqual(applied.value.crossfades);
  });

  it('changes nothing', () => {
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    plannedCrossfades(request(document, ['b'], -20));
    expect(spanOf(document, 'b')).toEqual([100, 200]);
    expect(locateClip(document, clipId('b'))!.clip.fade).toBeUndefined();
  });
});
