import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type TimelineDocument,
  type VideoTrack,
  FRAME_RATES,
  animatedNumber,
  assetPath,
  clipId,
  createDocument,
  evaluateAt,
  frameIndex,
  keyframeId,
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import {
  TRANSFORM_CHANNELS,
  clipTransform,
  isTransformed,
  neutralTransform,
  resetTransform,
  setTransformChannel,
  transformSpec,
} from './clip-transform.js';

/**
 * Framing a clip.
 *
 * The compositor has evaluated all five channels per frame since M4 and nothing could write one, so
 * every clip sat centred, unscaled and fully opaque forever. What is asserted here is the part that
 * makes the controls trustworthy: a channel written is a channel the render reads, a locked track
 * still refuses, and a reset is exact rather than nearly.
 */

function video(overrides: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId('c1'),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: 'take.mp4',
    enabled: true,
    effects: [],
    source: {
      asset: assetPath('media/take.mp4'),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform: neutralTransform(),
    speed: { factor: 1, preservePitch: true },
    ...overrides,
  } as Clip;
}

function audio(): Clip {
  return {
    kind: 'audio',
    id: clipId('a1'),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: 'bed.flac',
    enabled: true,
    effects: [],
    source: {
      asset: assetPath('media/bed.flac'),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
    },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
  } as unknown as AudioClip;
}

function documentWith(clip: Clip, locked = false): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1t'), text: trackId('t1') },
  });

  const kind = clip.kind === 'audio' ? 'audio' : 'video';
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === kind ? ({ ...track, locked, clips: [clip] } as VideoTrack) : track,
      ),
    },
  };
}

const transformOf = (document: TimelineDocument, id = 'c1') => {
  const located = locateClip(document, clipId(id));
  return located === undefined ? undefined : clipTransform(located.clip);
};

describe('writing a channel', () => {
  it('reaches the document, which nothing else could make it do', () => {
    const result = setTransformChannel(documentWith(video()), clipId('c1'), 'scale', staticNumber(2));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(transformOf(result.value)?.scale).toEqual(staticNumber(2));
  });

  it('leaves the other channels alone', () => {
    const result = setTransformChannel(documentWith(video()), clipId('c1'), 'x', staticNumber(0.25));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const transform = transformOf(result.value);
    expect(transform?.y).toEqual(staticNumber(0));
    expect(transform?.opacity).toEqual(staticNumber(1));
  });

  it('accepts an animated value, so the inspector and the lane write the same place', () => {
    // The three writers — a field, an animate toggle, a keyframe lane — must go through one function,
    // or they end up disagreeing about what a clip's opacity is.
    const fade = animatedNumber([
      { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
      { id: keyframeId('k1'), frame: frameIndex(50), value: 0, ease: 'linear' },
    ]);
    const result = setTransformChannel(documentWith(video()), clipId('c1'), 'opacity', fade);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opacity = transformOf(result.value)?.opacity;
    expect(opacity).toBeDefined();
    expect(evaluateAt(opacity!, frameIndex(25))).toBeCloseTo(0.5, 5);
  });

  it('refuses on a locked track, like every other edit', () => {
    const result = setTransformChannel(documentWith(video(), true), clipId('c1'), 'scale', staticNumber(2));
    expect(result.ok).toBe(false);
  });

  it('refuses for a clip that is not there, rather than throwing', () => {
    // Reached through a selection a concurrent undo has already emptied.
    const result = setTransformChannel(documentWith(video()), clipId('gone'), 'scale', staticNumber(2));
    expect(result.ok).toBe(false);
  });

  it('does nothing to an audio clip, which has nothing to place', () => {
    const result = setTransformChannel(documentWith(audio()), clipId('a1'), 'scale', staticNumber(2));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(transformOf(result.value, 'a1')).toBeUndefined();
  });
});

describe('resetting', () => {
  it('returns every channel to neutral exactly', () => {
    // Exactly, because dragging back to centre by hand cannot be, and being a hundredth off is
    // invisible until it is composited against something that is not.
    const framed = video({
      transform: {
        x: staticNumber(0.4),
        y: staticNumber(-0.2),
        scale: staticNumber(1.75),
        rotation: staticNumber(30),
        opacity: staticNumber(0.5),
      },
    } as Partial<Clip>);

    const result = resetTransform(documentWith(framed), clipId('c1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(transformOf(result.value)).toEqual(neutralTransform());
  });

  it('discards an animation, which is what abandoning framing means', () => {
    const spun = video({
      transform: {
        ...neutralTransform(),
        rotation: animatedNumber([{ id: keyframeId('k'), frame: frameIndex(0), value: 90, ease: 'linear' }]),
      },
    } as Partial<Clip>);

    const result = resetTransform(documentWith(spun), clipId('c1'));
    expect(result.ok && transformOf(result.value)?.rotation.kind).toBe('static');
  });
});

describe('what neutral means', () => {
  it('changes nothing when rendered', () => {
    const neutral = neutralTransform();
    expect(evaluateAt(neutral.scale, frameIndex(0))).toBe(1);
    expect(evaluateAt(neutral.opacity, frameIndex(0))).toBe(1);
    expect(evaluateAt(neutral.x, frameIndex(0))).toBe(0);
    expect(evaluateAt(neutral.rotation, frameIndex(0))).toBe(0);
  });

  it('is not reported as framed', () => {
    expect(isTransformed(video())).toBe(false);
  });

  it('is reported as framed once any channel differs', () => {
    for (const channel of TRANSFORM_CHANNELS) {
      const spec = transformSpec(channel);
      const clip = video({
        transform: { ...neutralTransform(), [channel]: staticNumber(spec.neutral + 0.5) },
      } as Partial<Clip>);
      expect(isTransformed(clip)).toBe(true);
    }
  });

  it('is reported as framed for an animated channel even at a neutral value', () => {
    // A one-marker animation holding 1.0 is still authored intent, and a reset would discard it —
    // so the control that discards it has to be offered.
    const clip = video({
      transform: {
        ...neutralTransform(),
        opacity: animatedNumber([{ id: keyframeId('k'), frame: frameIndex(0), value: 1, ease: 'linear' }]),
      },
    } as Partial<Clip>);
    expect(isTransformed(clip)).toBe(true);
  });

  it('says an audio clip is not framed, because it has no framing', () => {
    expect(isTransformed(audio())).toBe(false);
  });
});

describe('the channel specs', () => {
  it('cover every channel, so a lookup can never fail', () => {
    for (const channel of TRANSFORM_CHANNELS) {
      expect(transformSpec(channel).channel).toBe(channel);
    }
  });

  it('bound a slider without constraining the document', () => {
    // Scaling to 8× is legitimate; the slider simply does not span it. A spec that were a rule would
    // make the number field lie about what it accepts.
    const result = setTransformChannel(documentWith(video()), clipId('c1'), 'scale', staticNumber(8));
    expect(result.ok && evaluateAt(transformOf(result.value)!.scale, frameIndex(0))).toBe(8);
  });
});
