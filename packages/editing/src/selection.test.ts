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
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { allClips, clipsInRegion, combineSelection, withLinkedClips } from './selection.js';

/**
 * Which clips a gesture selects.
 *
 * The rule that matters is intersection rather than containment: a marquee is reached for precisely
 * when there is too much on screen to click, and at that zoom the clip a user wants usually runs off
 * both edges of their rectangle.
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
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

function audio(id: string, start: number, end: number, extra: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.flac'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...extra,
  } as AudioClip;
}

function documentWith(video: readonly Clip[], audioClips: readonly AudioClip[] = []): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) => {
        if (track.kind === 'video' && video.length > 0) return { ...track, clips: video } as Track;
        if (track.kind === 'audio' && audioClips.length > 0) return { ...track, clips: audioClips } as Track;
        return track;
      }),
    },
  };
}

const region = (from: number, to: number, tracks: readonly string[]) => ({
  span: spanFromBounds(frameIndex(from), frameIndex(to)),
  tracks: tracks.map((id) => trackId(id)),
});

describe('what a rectangle touches', () => {
  it('takes the clips it crosses', () => {
    const document = documentWith([video('a', 0, 100), video('b', 200, 300), video('c', 400, 500)]);
    expect(clipsInRegion(document, region(50, 250, ['v1']))).toEqual(['a', 'b']);
  });

  it('takes a clip whose ends are both outside it', () => {
    // The case a marquee exists for: at the zoom where a user reaches for one, the clip they want
    // usually runs off both edges of their rectangle.
    const document = documentWith([video('long', 0, 5000)]);
    expect(clipsInRegion(document, region(1000, 1100, ['v1']))).toEqual(['long']);
  });

  it('ignores tracks the rectangle did not cross', () => {
    const document = documentWith([video('a', 0, 100)], [audio('m', 0, 100)]);
    expect(clipsInRegion(document, region(0, 200, ['v1']))).toEqual(['a']);
  });

  it('takes clips from every track it did cross', () => {
    const document = documentWith([video('a', 0, 100)], [audio('m', 0, 100)]);
    expect(clipsInRegion(document, region(0, 200, ['v1', 'a1']))).toEqual(['a', 'm']);
  });

  it('takes nothing from an empty rectangle', () => {
    const document = documentWith([video('a', 0, 100)]);
    expect(clipsInRegion(document, region(200, 300, ['v1']))).toEqual([]);
  });

  it('does not take a clip that merely abuts the edge', () => {
    // Spans are half-open, so a clip ending exactly where the rectangle starts is not inside it —
    // and selecting it would surprise anyone dragging carefully up to a cut.
    const document = documentWith([video('a', 0, 100)]);
    expect(clipsInRegion(document, region(100, 200, ['v1']))).toEqual([]);
  });
});

describe('combining with what was selected', () => {
  it('replaces by default', () => {
    expect([...combineSelection(new Set(['old']), [clipId('a')], false)]).toEqual(['a']);
  });

  it('adds when a modifier is held', () => {
    expect([...combineSelection(new Set(['old']), [clipId('a')], true)].sort()).toEqual(['a', 'old']);
  });

  it('adds rather than toggles, so a second drag cannot deselect', () => {
    // A toggle would quietly remove anything caught by both drags, which is the opposite of what
    // building a selection up means.
    const first = combineSelection(new Set(), [clipId('a')], true);
    expect([...combineSelection(first, [clipId('a')], true)]).toEqual(['a']);
  });

  it('clears when an empty result replaces the selection', () => {
    expect([...combineSelection(new Set(['old']), [], false)]).toEqual([]);
  });
});

describe('everything', () => {
  it('collects clips from every track', () => {
    const document = documentWith([video('a', 0, 100)], [audio('m', 0, 100)]);
    expect([...allClips(document)].sort()).toEqual(['a', 'm']);
  });

  it('is empty for an empty timeline', () => {
    expect(allClips(documentWith([]))).toEqual([]);
  });
});

describe('linked clips', () => {
  it('reaches the audio split from a video at import', () => {
    // A video and its audio are one thing to a user, so an operation on either should reach both.
    const document = documentWith(
      [video('v', 0, 100, { linkedAudio: clipId('a') })],
      [audio('a', 0, 100, { linkedVideo: clipId('v') })],
    );

    expect([...withLinkedClips(document, [clipId('v')])].sort()).toEqual(['a', 'v']);
  });

  it('reaches the video from the audio', () => {
    const document = documentWith(
      [video('v', 0, 100, { linkedAudio: clipId('a') })],
      [audio('a', 0, 100, { linkedVideo: clipId('v') })],
    );

    expect([...withLinkedClips(document, [clipId('a')])].sort()).toEqual(['a', 'v']);
  });

  it('leaves an unlinked clip alone', () => {
    const document = documentWith([video('v', 0, 100)]);
    expect(withLinkedClips(document, [clipId('v')])).toEqual(['v']);
  });

  it('does not duplicate a pair already selected whole', () => {
    const document = documentWith(
      [video('v', 0, 100, { linkedAudio: clipId('a') })],
      [audio('a', 0, 100, { linkedVideo: clipId('v') })],
    );

    expect(withLinkedClips(document, [clipId('v'), clipId('a')])).toHaveLength(2);
  });
});
