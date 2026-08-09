import { describe, expect, it } from 'vitest';
import {
  FRAME_RATES,
  type AudioClip,
  type TimelineDocument,
  type Track,
  type VideoClip,
  assetPath,
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
import { MAX_SPEED, MIN_SPEED, fittedDuration, setClipSpeed, speedOf } from './clip-speed.js';

/**
 * Retiming a clip.
 *
 * The pipeline honoured `ClipSpeed` from M4; nothing could set it, so every clip in every project sat
 * at 1× forever.
 */

const video = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: clipId('v'),
  kind: 'video',
  span: spanFromBounds(frameIndex(0), frameIndex(90)),
  label: 'shot',
  enabled: true,
  effects: [],
  transform: {
    x: staticNumber(0),
    y: staticNumber(0),
    scale: staticNumber(1),
    rotation: staticNumber(0),
    opacity: staticNumber(1),
  },
  speed: { factor: 1, preservePitch: true },
  source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
  ...over,
});

const audio = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: clipId('a'),
  kind: 'audio',
  span: spanFromBounds(frameIndex(0), frameIndex(90)),
  label: 'sound',
  enabled: true,
  effects: [],
  speed: { factor: 1, preservePitch: true },
  gain: staticNumber(1),
  pan: staticNumber(0),
  source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
  ...over,
});

function documentWith(clips: {
  video?: readonly VideoClip[];
  audio?: readonly AudioClip[];
}): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'retime',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') },
  });

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === 'video'
          ? ({ ...track, clips: clips.video ?? [] } as Track)
          : track.kind === 'audio'
            ? ({ ...track, clips: clips.audio ?? [] } as Track)
            : track,
      ),
    },
  };
}

const speedIn = (document: TimelineDocument, id: string) => {
  const found = locateClip(document, clipId(id));
  return found === undefined ? undefined : speedOf(found.clip);
};

const spanIn = (document: TimelineDocument, id: string) => locateClip(document, clipId(id))?.clip.span;

describe('changing the factor', () => {
  it('writes it', () => {
    const result = setClipSpeed(documentWith({ video: [video()] }), clipId('v'), { factor: 2 });
    expect(result.ok && speedIn(result.value, 'v')?.factor).toBe(2);
  });

  it('leaves the clip where it is, which is the model’s own meaning', () => {
    // "Retimes the source read, not the timeline placement" — the same slot shows twice as much
    // material, which is what you want when the cut is already made to music.
    const result = setClipSpeed(documentWith({ video: [video()] }), clipId('v'), { factor: 2 });
    expect(result.ok && (spanIn(result.value, 'v')?.duration as number)).toBe(90);
  });

  it('leaves pitch handling alone when it is not mentioned', () => {
    const start = documentWith({ video: [video({ speed: { factor: 1, preservePitch: false } })] });
    const result = setClipSpeed(start, clipId('v'), { factor: 2 });
    expect(result.ok && speedIn(result.value, 'v')?.preservePitch).toBe(false);
  });

  it('clamps to what the application can play', () => {
    const document = documentWith({ video: [video()] });
    const fast = setClipSpeed(document, clipId('v'), { factor: 1000 });
    const slow = setClipSpeed(document, clipId('v'), { factor: 0.0001 });
    expect(fast.ok && speedIn(fast.value, 'v')?.factor).toBe(MAX_SPEED);
    expect(slow.ok && speedIn(slow.value, 'v')?.factor).toBe(MIN_SPEED);
  });

  it('refuses a factor that is not a number rather than writing one', () => {
    // A non-finite factor serializes as `null` and the schema rejects it on the way back in, so the
    // project would open broken rather than slow.
    const result = setClipSpeed(documentWith({ video: [video()] }), clipId('v'), { factor: Number.NaN });
    expect(result.ok && speedIn(result.value, 'v')?.factor).toBe(1);
  });
});

describe('keeping the material instead of the length', () => {
  it('doubles the length at half speed', () => {
    const result = setClipSpeed(
      documentWith({ video: [video()] }),
      clipId('v'),
      { factor: 0.5 },
      {
        fitDuration: true,
      },
    );
    expect(result.ok && (spanIn(result.value, 'v')?.duration as number)).toBe(180);
  });

  it('halves it at double speed', () => {
    const result = setClipSpeed(
      documentWith({ video: [video()] }),
      clipId('v'),
      { factor: 2 },
      {
        fitDuration: true,
      },
    );
    expect(result.ok && (spanIn(result.value, 'v')?.duration as number)).toBe(45);
  });

  it('scales from the speed it is already at, not from 1', () => {
    // Going 2× → 4× halves the length again; treating the current speed as 1 would double it instead.
    const start = documentWith({ video: [video({ speed: { factor: 2, preservePitch: true } })] });
    const result = setClipSpeed(start, clipId('v'), { factor: 4 }, { fitDuration: true });
    expect(result.ok && (spanIn(result.value, 'v')?.duration as number)).toBe(45);
  });

  it('never collapses a clip to nothing', () => {
    const short = documentWith({ video: [video({ span: spanFromBounds(frameIndex(0), frameIndex(2)) })] });
    const result = setClipSpeed(short, clipId('v'), { factor: MAX_SPEED }, { fitDuration: true });
    expect(result.ok && (spanIn(result.value, 'v')?.duration as number)).toBe(1);
  });

  it('refuses when growing would run into the next clip, and says which', () => {
    const document = documentWith({
      video: [video(), video({ id: clipId('next'), span: spanFromBounds(frameIndex(90), frameIndex(150)) })],
    });
    const result = setClipSpeed(document, clipId('v'), { factor: 0.5 }, { fitDuration: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({ kind: 'collision', track: 'V1', withClip: 'next' });
  });

  it('leaves the document untouched when it refuses', () => {
    const document = documentWith({
      video: [video(), video({ id: clipId('next'), span: spanFromBounds(frameIndex(90), frameIndex(150)) })],
    });
    setClipSpeed(document, clipId('v'), { factor: 0.5 }, { fitDuration: true });
    expect(speedIn(document, 'v')?.factor).toBe(1);
  });
});

describe('linked audio', () => {
  const linked = () =>
    documentWith({
      video: [video({ linkedAudio: clipId('a') })],
      audio: [audio({ linkedVideo: clipId('v') })],
    });

  it('is retimed with the picture', () => {
    // Retiming one without the other is sound drifting a little further out with every second: small
    // at first and unfixable later, because by then the two have different lengths.
    const result = setClipSpeed(linked(), clipId('v'), { factor: 2 });
    expect(result.ok && speedIn(result.value, 'a')?.factor).toBe(2);
  });

  it('keeps the same length as the picture when the length changes', () => {
    const result = setClipSpeed(linked(), clipId('v'), { factor: 0.5 }, { fitDuration: true });
    expect(result.ok && (spanIn(result.value, 'a')?.duration as number)).toBe(180);
    expect(result.ok && (spanIn(result.value, 'v')?.duration as number)).toBe(180);
  });

  it('refuses the whole edit when the sound cannot follow', () => {
    // Applying the picture and then discovering the sound cannot follow would commit the exact drift
    // this exists to prevent.
    const blocked = documentWith({
      video: [video({ linkedAudio: clipId('a') })],
      audio: [
        audio({ linkedVideo: clipId('v') }),
        audio({ id: clipId('later'), span: spanFromBounds(frameIndex(90), frameIndex(150)) }),
      ],
    });
    const result = setClipSpeed(blocked, clipId('v'), { factor: 0.5 }, { fitDuration: true });
    expect(result.ok).toBe(false);
  });

  it('ignores a link pointing at a clip that is gone', () => {
    // A stale link must not block an ordinary edit; the picture is still retimed.
    const stale = documentWith({ video: [video({ linkedAudio: clipId('missing') })] });
    const result = setClipSpeed(stale, clipId('v'), { factor: 2 });
    expect(result.ok && speedIn(result.value, 'v')?.factor).toBe(2);
  });
});

describe('what cannot be retimed', () => {
  it('refuses a clip that is not there', () => {
    const result = setClipSpeed(documentWith({}), clipId('nonesuch'), { factor: 2 });
    expect(!result.ok && result.error.kind).toBe('clip-not-found');
  });

  it('refuses a locked track', () => {
    const document = documentWith({ video: [video()] });
    const locked = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.kind === 'video' ? ({ ...track, locked: true } as Track) : track,
        ),
      },
    };
    expect(setClipSpeed(locked, clipId('v'), { factor: 2 }).ok).toBe(false);
  });
});

describe('the length a clip needs at a new speed', () => {
  it('is longer as it slows and shorter as it speeds up', () => {
    expect(fittedDuration(video(), 0.5)).toBe(180);
    expect(fittedDuration(video(), 3)).toBe(30);
  });

  it('is 1 for a clip that cannot be retimed, which has no speed to scale', () => {
    expect(speedOf({ ...video(), kind: 'image' } as never).factor).toBe(1);
  });
});
