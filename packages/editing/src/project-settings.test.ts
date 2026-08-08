import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type TimelineDocument,
  type Track,
  FRAME_RATES,
  animatedNumber,
  assetPath,
  clipId,
  createDocument,
  frameIndex,
  keyframeId,
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { applyProjectSettings, retimeCost } from './project-settings.js';

/**
 * Changing a project's rate and resolution.
 *
 * Every time in the document is a frame index *at the project rate*, so changing the rate without
 * rebasing them would silently retime the whole programme — a cut two seconds in at 24 fps would land
 * at 1.6 seconds at 30. These tests are all about that: what moves, what must not, and what it costs.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.FILM_24 },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

function documentAt(rate = FRAME_RATES.WEB_30, clips: readonly Clip[] = [video('a', 0, 60)]) {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: rate,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === 'video' ? ({ ...track, clips } as Track) : track,
      ),
    },
  };
}

const settings = (rate = FRAME_RATES.WEB_30, width = 1920, height = 1080) => ({
  frameRate: rate,
  resolution: { width, height },
});

describe('resolution', () => {
  it('changes without moving anything', () => {
    // Transforms are normalized to [0, 1] of the output, which is what makes this the easy half.
    const document = documentAt();
    const result = applyProjectSettings(document, settings(FRAME_RATES.WEB_30, 3840, 2160));

    expect(result.ok && result.value.resolution).toEqual({ width: 3840, height: 2160 });
    expect(result.ok && locateClip(result.value, clipId('a'))?.clip.span.start).toBe(0);
  });
});

describe('changing the rate', () => {
  it('keeps a clip at the same moment in time', () => {
    // Two seconds in at 30 fps is frame 60; at 24 it is frame 48. Leaving the number alone would
    // silently retime the whole programme.
    const document = documentAt(FRAME_RATES.WEB_30, [video('a', 60, 120)]);
    const result = applyProjectSettings(document, settings(FRAME_RATES.FILM_24));

    expect(result.ok && locateClip(result.value, clipId('a'))?.clip.span.start).toBe(48);
  });

  it('never loses a clip´s tail', () => {
    // Durations round up: a duration rounded down would shorten material, where a start rounded to
    // nearest moves it by at most half a frame.
    const document = documentAt(FRAME_RATES.WEB_30, [video('a', 0, 1)]);
    const result = applyProjectSettings(document, settings(FRAME_RATES.FILM_24));

    expect(result.ok && locateClip(result.value, clipId('a'))?.clip.span.duration).toBeGreaterThan(0);
  });

  it('rebases keyframes, so animation stays where it was', () => {
    const clip = video('a', 0, 120, {
      transform: {
        ...transform,
        opacity: animatedNumber([
          { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
          { id: keyframeId('k1'), frame: frameIndex(60), value: 0, ease: 'linear' },
        ]),
      },
    });

    const result = applyProjectSettings(
      documentAt(FRAME_RATES.WEB_30, [clip]),
      settings(FRAME_RATES.FILM_24),
    );
    const located = result.ok ? locateClip(result.value, clipId('a')) : undefined;
    const opacity = located?.clip.kind === 'video' ? located.clip.transform.opacity : undefined;

    expect(opacity?.kind === 'animated' && opacity.keyframes[1]?.frame).toBe(48);
  });

  it('rebases an audio clip´s level automation', () => {
    const clip = {
      kind: 'audio',
      id: clipId('m'),
      span: spanFromBounds(frameIndex(0), frameIndex(120)),
      label: 'm',
      enabled: true,
      effects: [],
      source: { asset: assetPath('media/a.flac'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
      speed: { factor: 1, preservePitch: true },
      gain: animatedNumber([
        { id: keyframeId('g0'), frame: frameIndex(0), value: 1, ease: 'linear' },
        { id: keyframeId('g1'), frame: frameIndex(60), value: 0, ease: 'linear' },
      ]),
      pan: staticNumber(0),
    } as AudioClip;

    const base = documentAt(FRAME_RATES.WEB_30, []);
    const withAudio: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.kind === 'audio' ? ({ ...track, clips: [clip] } as Track) : track,
        ),
      },
    };

    const result = applyProjectSettings(withAudio, settings(FRAME_RATES.FILM_24));
    const located = result.ok ? locateClip(result.value, clipId('m')) : undefined;
    const gain = located?.clip.kind === 'audio' ? located.clip.gain : undefined;

    expect(gain?.kind === 'animated' && gain.keyframes[1]?.frame).toBe(48);
  });

  it('leaves the source rate alone, which describes the file and not the timeline', () => {
    // The one conversion this must not do: rebasing it would make every frame read from the wrong
    // place in the media.
    const document = documentAt(FRAME_RATES.WEB_30, [video('a', 0, 60)]);
    const result = applyProjectSettings(document, settings(FRAME_RATES.FILM_24));
    const located = result.ok ? locateClip(result.value, clipId('a')) : undefined;

    expect(located?.clip.kind === 'video' && located.clip.source.sourceRate).toEqual(FRAME_RATES.FILM_24);
  });

  it('rebases markers and the in/out range', () => {
    const base = documentAt(FRAME_RATES.WEB_30);
    const marked: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        markers: [{ frame: frameIndex(60), label: 'cue' }],
        workRange: spanFromBounds(frameIndex(30), frameIndex(90)),
      },
    };

    const result = applyProjectSettings(marked, settings(FRAME_RATES.FILM_24));
    expect(result.ok && result.value.sequence.markers[0]?.frame).toBe(48);
    expect(result.ok && result.value.sequence.workRange?.start).toBe(24);
  });

  it('records the new rate on the document', () => {
    const result = applyProjectSettings(documentAt(), settings(FRAME_RATES.PAL_25));
    expect(result.ok && result.value.frameRate).toEqual(FRAME_RATES.PAL_25);
  });
});

describe('what a rate change costs', () => {
  it('is nothing when the rate does not change', () => {
    expect(retimeCost(documentAt(FRAME_RATES.WEB_30), FRAME_RATES.WEB_30).rounded).toBe(0);
  });

  it('is nothing when every position converts exactly', () => {
    // 30 → 60 doubles every frame index, so nothing is rounded.
    const document = documentAt(FRAME_RATES.WEB_30, [video('a', 0, 60)]);
    expect(retimeCost(document, FRAME_RATES.WEB_60).rounded).toBe(0);
  });

  it('counts the positions that will be rounded', () => {
    // 30 → 24 cannot express every frame, which is a real and irreversible cost.
    const document = documentAt(FRAME_RATES.WEB_30, [video('a', 1, 62)]);
    const cost = retimeCost(document, FRAME_RATES.FILM_24);

    expect(cost.rounded).toBeGreaterThan(0);
    expect(cost.total).toBeGreaterThanOrEqual(cost.rounded);
  });

  it('names both rates, so the message can say what is happening', () => {
    const cost = retimeCost(documentAt(FRAME_RATES.WEB_30), FRAME_RATES.FILM_24);
    expect(cost.from).toEqual(FRAME_RATES.WEB_30);
    expect(cost.to).toEqual(FRAME_RATES.FILM_24);
  });
});
