import { describe, expect, it } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type Track,
  type VideoClip,
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
import { type SourceBoundsResolver } from './clip-ops.js';
import { clipsPastTheirSource, describeSourceOverruns, missingSourceFrames } from './source-reach.js';

/**
 * Clips that outrun their media.
 *
 * Trimming has been guarded since M2 — an edge cannot be pulled past the end of a file — and a
 * *document* could hold such a clip anyway with nothing saying so. Found by making one: an edit built
 * from four-second beds asked for five-second shots, thirty times over, and the application drew it
 * without complaint. Black frames that look exactly like a shot meant to end on black.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, duration: number, overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(start + duration)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...overrides,
  } as VideoClip;
}

/** A resolver that answers the same length for everything, which is what a probe cache looks like. */
const holding = (frames: number): SourceBoundsResolver => ({ boundsFor: () => ({ totalFrames: frames }) });
const unprobed: SourceBoundsResolver = { boundsFor: () => undefined };

function documentWith(clips: readonly Clip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') },
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

describe('a clip against its source', () => {
  it('reports the frames a clip asks for and the source does not have', () => {
    // The exact fault from the promo edit: 150 frames off a 120-frame bed.
    expect(missingSourceFrames(video('shot', 0, 150), holding(120))).toBe(30);
  });

  it('says nothing when the clip fits exactly', () => {
    expect(missingSourceFrames(video('shot', 0, 120), holding(120))).toBe(0);
  });

  it('counts from the clip´s in-point, not from the head of the file', () => {
    // A clip starting ten frames in has ten fewer to work with, which is the whole reason `sourceIn`
    // exists.
    expect(
      missingSourceFrames(
        video('shot', 0, 120, {
          source: {
            asset: assetPath('media/a.mp4'),
            sourceIn: frameIndex(10),
            sourceRate: FRAME_RATES.WEB_30,
          },
        }),
        holding(120),
      ),
    ).toBe(10);
  });

  it('says nothing while the source is unprobed', () => {
    // An unprobed source is not a broken one, and warning about every clip until the probes land would
    // train the user to ignore the warning.
    expect(missingSourceFrames(video('shot', 0, 9999), unprobed)).toBe(0);
  });

  it('honours a retime, so a slowed shot is not falsely accused', () => {
    // At half speed a clip consumes half a frame of source per frame of timeline: 200 frames of
    // timeline off 100 frames of source is exactly right.
    const slow = video('slow', 0, 200, { speed: { factor: 0.5, preservePitch: true } });
    expect(missingSourceFrames(slow, holding(100))).toBe(0);
  });

  it('accuses a sped-up shot that really does run out', () => {
    const fast = video('fast', 0, 200, { speed: { factor: 2, preservePitch: true } });
    expect(missingSourceFrames(fast, holding(300))).toBe(100);
  });

  it('leaves a still alone, because holding one frame is what a still is for', () => {
    const still = { ...video('img', 0, 300), kind: 'image' } as unknown as Clip;
    expect(missingSourceFrames(still, holding(1))).toBe(0);
  });

  it('leaves a title alone, having no file to outrun', () => {
    const title = { ...video('t', 0, 300), kind: 'text', source: undefined } as unknown as Clip;
    expect(missingSourceFrames(title, holding(1))).toBe(0);
  });
});

describe('the whole document', () => {
  it('finds every offender, in timeline order', () => {
    const document = documentWith([video('late', 300, 150), video('early', 0, 150)]);
    const found = clipsPastTheirSource(document, holding(120));

    expect(found.map((entry) => entry.clip)).toEqual(['early', 'late']);
    expect(found[0]?.missing).toBe(30);
    expect(found[0]?.available).toBe(120);
  });

  it('finds nothing in a document that fits', () => {
    expect(clipsPastTheirSource(documentWith([video('ok', 0, 100)]), holding(120))).toEqual([]);
  });

  it('names the first and counts the rest', () => {
    const document = documentWith([video('a', 0, 150), video('b', 200, 150), video('c', 400, 150)]);
    const line = describeSourceOverruns(clipsPastTheirSource(document, holding(120)));

    expect(line).toContain('a runs 30 frames past its source');
    expect(line).toContain('and 2 more');
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(describeSourceOverruns([])).toBeUndefined();
  });

  it('uses the singular for one frame, which is the commonest case after an edit', () => {
    const document = documentWith([video('a', 0, 121)]);
    expect(describeSourceOverruns(clipsPastTheirSource(document, holding(120)))).toContain('1 frame past');
  });
});
