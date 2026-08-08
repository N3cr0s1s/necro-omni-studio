import { describe, expect, it } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type VideoTrack,
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
import { describeFrameGrab, frameGrabTarget, stillPath } from './frame-grab.js';

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, end: number, extra: Record<string, unknown> = {}): Clip {
  const { source, ...rest } = extra as { source?: Record<string, unknown> };
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
      ...source,
    },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...rest,
  } as Clip;
}

function makeDocument(perTrack: readonly (readonly Clip[])[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

  const [first = [], second] = perTrack;
  const v1: VideoTrack = { ...(base.sequence.tracks[0] as VideoTrack), clips: first as VideoTrack['clips'] };
  const tracks =
    second === undefined
      ? [v1, ...base.sequence.tracks.slice(1)]
      : [
          v1,
          ...base.sequence.tracks.slice(1),
          {
            ...v1,
            id: trackId('v2'),
            name: 'V2',
            clips: second as VideoTrack['clips'],
          },
        ];

  return { ...base, sequence: { ...base.sequence, tracks } };
}

describe('what the playhead is over', () => {
  it('is nothing when no video covers it', () => {
    const doc = makeDocument([[video('a', 0, 100)]]);
    expect(frameGrabTarget(doc, frameIndex(200))).toBeUndefined();
  });

  it('names the source and the frame within it', () => {
    const doc = makeDocument([[video('a', 0, 100)]]);
    const target = frameGrabTarget(doc, frameIndex(30));

    expect(target?.asset).toBe('media/a.mp4');
    expect(target?.sourceFrame).toBe(30);
    expect(target?.seconds).toBeCloseTo(1, 6);
  });

  it('counts from the clip’s source in-point, not from the timeline', () => {
    // A trimmed clip is the common case; using the timeline frame would grab from the wrong place
    // by exactly however much was trimmed off the head.
    const doc = makeDocument([[video('a', 100, 200, { source: { sourceIn: frameIndex(500) } })]]);
    expect(frameGrabTarget(doc, frameIndex(130))?.sourceFrame).toBe(530);
  });

  it('converts at the source’s rate, not the project’s', () => {
    // Ten seconds into a 24 fps source on a 30 fps timeline is source frame 240, not 300. A naive
    // subtraction drifts further the deeper into the clip you are.
    const doc = makeDocument([[video('a', 0, 900, { source: { sourceRate: FRAME_RATES.FILM_24 } })]]);
    const target = frameGrabTarget(doc, frameIndex(300));
    expect(target?.sourceFrame).toBe(240);
    expect(target?.seconds).toBeCloseTo(10, 6);
  });

  it('follows a retimed clip, so the frame is the one on screen', () => {
    const doc = makeDocument([[video('a', 0, 300, { speed: { factor: 0.5, preservePitch: true } })]]);
    expect(frameGrabTarget(doc, frameIndex(100))?.sourceFrame).toBe(50);
  });

  it('takes the topmost track, which is what the preview shows', () => {
    const doc = makeDocument([[video('under', 0, 300)], [video('over', 0, 300)]]);
    expect(frameGrabTarget(doc, frameIndex(50))?.asset).toBe('media/over.mp4');
  });

  it('ignores a disabled clip, which is not on screen either', () => {
    const doc = makeDocument([[video('under', 0, 300)], [video('over', 0, 300, { enabled: false })]]);
    expect(frameGrabTarget(doc, frameIndex(50))?.asset).toBe('media/under.mp4');
  });

  it('treats a span as half-open, matching every other edit', () => {
    const doc = makeDocument([[video('a', 0, 100)]]);
    expect(frameGrabTarget(doc, frameIndex(99))).toBeDefined();
    expect(frameGrabTarget(doc, frameIndex(100))).toBeUndefined();
  });
});

describe('where the frame is written', () => {
  it('is named after the source and the frame, so grabbing twice is one file', () => {
    expect(stillPath(assetPath('media/take 1.mp4'), frameIndex(42))).toBe('media/stills/take-1_000042.png');
  });

  it('is inside the project but never under the cache', () => {
    // A still is an input a run is pinned to; clearing the cache must not break reproducing it.
    expect(stillPath(assetPath('media/a.mp4'), frameIndex(1)).startsWith('media/')).toBe(true);
  });

  it('strips characters that are legal here and fatal on Windows', () => {
    // A project that opens on Linux must open on Windows.
    expect(stillPath(assetPath('media/a:b?c.mp4'), frameIndex(1))).toBe('media/stills/a-b-c_000001.png');
  });

  it('pads the frame number, so a listing sorts in time order', () => {
    expect(stillPath(assetPath('media/a.mp4'), frameIndex(7))).toContain('_000007.');
    expect(stillPath(assetPath('media/a.mp4'), frameIndex(1_000_000))).toContain('_1000000.');
  });
});

describe('describing a grab', () => {
  it('says which frame of which file, since that is what the button promises', () => {
    const doc = makeDocument([[video('a', 0, 100)]]);
    const target = frameGrabTarget(doc, frameIndex(30));
    expect(target !== undefined && describeFrameGrab(target)).toBe('frame 30 of a.mp4');
  });
});
