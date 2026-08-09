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
  frameIndex,
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import {
  MIN_CROSSFADE_FRAMES,
  applyCrossfade,
  clearClipFade,
  crossfadeForPlacement,
  maxFadeFrames,
  setClipFade,
  setGroupFade,
} from './fade-ops.js';

/**
 * Fades and the crossfade an overlap makes.
 *
 * The asymmetry between the two media is the thing to protect: sound sums and picture occludes, so a
 * symmetric ramp is right for one and produces a flash of black in the other. Every test that touches
 * a crossfade therefore checks *both* clips.
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

interface Content {
  readonly v1?: readonly Clip[];
  readonly a1?: readonly AudioClip[];
  readonly t1?: readonly Clip[];
  readonly lock?: string;
}

function documentWith(content: Content): TimelineDocument {
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
        const clips =
          track.id === V1
            ? content.v1
            : track.id === A1
              ? content.a1
              : track.id === T1
                ? content.t1
                : undefined;
        const locked = track.id === content.lock;
        return { ...track, ...(clips === undefined ? {} : { clips }), locked } as Track;
      }),
    },
  };
}

const fadeOf = (document: TimelineDocument, id: string) => {
  const located = locateClip(document, clipId(id));
  if (located === undefined) throw new Error(`no clip ${id}`);
  return clipFade(located.clip);
};

/** A span the size of a clip, placed at a start — what a drop would produce. */
const at = (start: number, duration: number) =>
  spanFromBounds(frameIndex(start), frameIndex(start + duration));

describe('recognizing a crossfade in a drop', () => {
  const track = () => documentWith({ v1: [video('a', 0, 100), video('b', 200, 300)] });

  it('is the overlap of the placed clip with the one it lands on', () => {
    // `b` is 100 frames long and dropped at 80, so it covers the last 20 frames of `a`.
    const plan = crossfadeForPlacement(track(), clipId('b'), V1, at(80, 100));
    expect(plan).toEqual({
      track: V1,
      outgoing: 'a',
      incoming: 'b',
      span: spanFromBounds(frameIndex(80), frameIndex(100)),
    });
  });

  it('names whichever clip starts later as the incoming one', () => {
    // Dropping `b` so it *starts before* `a` makes `a` the arriving shot, whichever clip the pointer
    // happened to be on. The label decides which frame is on top, so getting it from the pointer
    // would dissolve the wrong way whenever a user dragged the earlier clip.
    const document = documentWith({ v1: [video('a', 20, 120), video('b', 400, 500)] });
    const plan = crossfadeForPlacement(document, clipId('b'), V1, at(0, 100));
    expect(plan?.outgoing).toBe('b');
    expect(plan?.incoming).toBe('a');
    expect(plan?.span).toEqual(spanFromBounds(frameIndex(20), frameIndex(100)));
  });

  it('is nothing when the clip lands in free space', () => {
    expect(crossfadeForPlacement(track(), clipId('b'), V1, at(120, 100))).toBeUndefined();
  });

  it('is nothing when two clips would be touched at once', () => {
    // Which of them is the outgoing side has no answer, and picking one silently is worse than
    // clamping the drag.
    const document = documentWith({ v1: [video('a', 0, 100), video('b', 200, 300), video('c', 400, 440)] });
    expect(crossfadeForPlacement(document, clipId('c'), V1, at(90, 120))).toBeUndefined();
  });

  it('is nothing when the overlap would swallow either clip', () => {
    const document = documentWith({ v1: [video('a', 0, 40), video('b', 200, 300)] });
    // `b` placed at 0 covers all 40 frames of `a`: a replacement, not a dissolve.
    expect(crossfadeForPlacement(document, clipId('b'), V1, at(0, 100))).toBeUndefined();
  });

  it('is nothing below the minimum, so two clips can still be butted together', () => {
    const plan = crossfadeForPlacement(track(), clipId('b'), V1, at(100 - MIN_CROSSFADE_FRAMES + 1, 100));
    expect(plan).toBeUndefined();
    expect(
      crossfadeForPlacement(track(), clipId('b'), V1, at(100 - MIN_CROSSFADE_FRAMES, 100)),
    ).toBeDefined();
  });

  it('is nothing on a text track, where two titles simply coexist', () => {
    const document = documentWith({ t1: [] });
    expect(crossfadeForPlacement(document, clipId('x'), T1, at(0, 100))).toBeUndefined();
  });

  it('is nothing on a locked track', () => {
    const document = documentWith({ v1: [video('a', 0, 100), video('b', 200, 300)], lock: V1 });
    expect(crossfadeForPlacement(document, clipId('b'), V1, at(80, 100))).toBeUndefined();
  });
});

describe('writing the ramps a crossfade needs', () => {
  it('ramps only the incoming picture, because the outgoing one is underneath and whole', () => {
    // Fading both would let the empty frame behind them show through in the middle of the dissolve —
    // a flash of black exactly where the join is meant to be invisible.
    const document = documentWith({ v1: [video('a', 0, 100), video('b', 80, 180)] });
    const plan = crossfadeForPlacement(document, clipId('b'), V1, at(80, 100))!;
    const result = applyCrossfade(document, plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fadeOf(result.value, 'b')).toEqual({ inFrames: 20, outFrames: 0 });
    expect(fadeOf(result.value, 'a')).toEqual({ inFrames: 0, outFrames: 0 });
  });

  it('ramps both sounds, because they are summed', () => {
    // A ramp on one alone leaves the other at full level under it, and the join comes out *louder*
    // than either clip.
    const document = documentWith({ a1: [audio('a', 0, 100), audio('b', 80, 180)] });
    const plan = crossfadeForPlacement(document, clipId('b'), A1, at(80, 100))!;
    const result = applyCrossfade(document, plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fadeOf(result.value, 'b')).toEqual({ inFrames: 20, outFrames: 0 });
    expect(fadeOf(result.value, 'a')).toEqual({ inFrames: 0, outFrames: 20 });
  });

  it('replaces rather than accumulates, so dragging further does not compound', () => {
    const document = documentWith({ a1: [audio('a', 0, 100), audio('b', 80, 180)] });
    const once = applyCrossfade(document, crossfadeForPlacement(document, clipId('b'), A1, at(80, 100))!);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = applyCrossfade(
      once.value,
      crossfadeForPlacement(once.value, clipId('b'), A1, at(80, 100))!,
    );
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(fadeOf(twice.value, 'a').outFrames).toBe(20);
  });
});

describe('setting a fade by hand', () => {
  const one = () => documentWith({ a1: [audio('a', 0, 100)] });

  it('changes one end and leaves the other alone', () => {
    const first = setClipFade(one(), clipId('a'), { inFrames: 10 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = setClipFade(first.value, clipId('a'), { outFrames: 25 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(fadeOf(second.value, 'a')).toEqual({ inFrames: 10, outFrames: 25 });
  });

  it('clamps to the clip rather than refusing, so a drag that ran long still lands', () => {
    const result = setClipFade(one(), clipId('a'), { inFrames: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fadeOf(result.value, 'a').inFrames).toBe(
      maxFadeFrames(locateClip(result.value, clipId('a'))!.clip),
    );
    expect(fadeOf(result.value, 'a').inFrames).toBe(100);
  });

  it('removes the field entirely at zero, so a clip without a fade compares as one', () => {
    const faded = setClipFade(one(), clipId('a'), { inFrames: 10, outFrames: 10 });
    expect(faded.ok).toBe(true);
    if (!faded.ok) return;
    const cleared = clearClipFade(faded.value, clipId('a'));
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(locateClip(cleared.value, clipId('a'))!.clip.fade).toBeUndefined();
  });

  it('is a no-op when nothing would change, so no history entry is recorded', () => {
    const document = one();
    const result = setClipFade(document, clipId('a'), { inFrames: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(document);
  });

  it('refuses on a locked track', () => {
    const document = documentWith({ a1: [audio('a', 0, 100)], lock: A1 });
    const result = setClipFade(document, clipId('a'), { inFrames: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('track-locked');
  });

  it('rounds a fractional length and rejects a non-finite one', () => {
    const rounded = setClipFade(one(), clipId('a'), { inFrames: 10.6 });
    expect(rounded.ok).toBe(true);
    if (!rounded.ok) return;
    expect(fadeOf(rounded.value, 'a').inFrames).toBe(11);

    const broken = setClipFade(one(), clipId('a'), { inFrames: Number.NaN });
    expect(broken.ok).toBe(true);
    if (!broken.ok) return;
    expect(fadeOf(broken.value, 'a').inFrames).toBe(0);
  });
});

/**
 * Fading a linked pair.
 *
 * The same rule the linked trim follows, and the case where getting it wrong is *more* obvious: a
 * picture that ramps while its own sound arrives at full level is something you hear.
 */
describe('setting a fade on a linked pair', () => {
  const pair = (extra: Partial<Clip> = {}) =>
    documentWith({
      v1: [video('v', 0, 100, { linkedAudio: clipId('a'), ...extra } as Partial<Clip>)],
      a1: [audio('a', 0, 100, { linkedVideo: clipId('v') })],
    });

  it('ramps both halves, grabbed from either side', () => {
    const fromVideo = setGroupFade(pair(), clipId('v'), { inFrames: 12 });
    expect(fromVideo.ok).toBe(true);
    if (!fromVideo.ok) return;
    expect(fadeOf(fromVideo.value, 'v').inFrames).toBe(12);
    expect(fadeOf(fromVideo.value, 'a').inFrames).toBe(12);

    const fromAudio = setGroupFade(pair(), clipId('a'), { outFrames: 8 });
    expect(fromAudio.ok).toBe(true);
    if (!fromAudio.ok) return;
    expect(fadeOf(fromAudio.value, 'v').outFrames).toBe(8);
    expect(fadeOf(fromAudio.value, 'a').outFrames).toBe(8);
  });

  it('clamps each half to its own length, since a pair need not be the same length', () => {
    const uneven = documentWith({
      v1: [video('v', 0, 100, { linkedAudio: clipId('a') } as Partial<Clip>)],
      a1: [audio('a', 0, 30, { linkedVideo: clipId('v') })],
    });
    const result = setGroupFade(uneven, clipId('v'), { inFrames: 60 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fadeOf(result.value, 'v').inFrames).toBe(60);
    expect(fadeOf(result.value, 'a').inFrames).toBe(30);
  });

  it('still fades the picture when its sound is on a locked track', () => {
    // Not all-or-nothing, unlike the trim: a fade cannot collide and cannot run out of material, so
    // the only way a partner refuses is a lock — and refusing the whole gesture then would let a
    // locked audio track silently prevent fading the picture above it.
    const locked = documentWith({
      v1: [video('v', 0, 100, { linkedAudio: clipId('a') } as Partial<Clip>)],
      a1: [audio('a', 0, 100, { linkedVideo: clipId('v') })],
      lock: A1,
    });
    const result = setGroupFade(locked, clipId('v'), { inFrames: 12 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fadeOf(result.value, 'v').inFrames).toBe(12);
    expect(fadeOf(result.value, 'a').inFrames).toBe(0);
  });

  it('refuses when the clip under the pointer is the locked one', () => {
    const locked = documentWith({
      v1: [video('v', 0, 100, { linkedAudio: clipId('a') } as Partial<Clip>)],
      a1: [audio('a', 0, 100, { linkedVideo: clipId('v') })],
      lock: V1,
    });
    const result = setGroupFade(locked, clipId('v'), { inFrames: 12 });
    expect(result.ok).toBe(false);
  });

  it('leaves an unlinked clip on the ordinary path', () => {
    const lone = documentWith({ v1: [video('v', 0, 100)], a1: [audio('a', 0, 100)] });
    const result = setGroupFade(lone, clipId('v'), { inFrames: 12 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fadeOf(result.value, 'a').inFrames).toBe(0);
  });
});
