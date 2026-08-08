import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type MaskDefinition,
  type TimelineDocument,
  type VideoClip,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  frameIndex,
  maskId,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { findUnusedTakes, referencedAssets } from './unused-takes.js';

/**
 * Which generated takes nothing is using.
 *
 * The spec leaves unaccepted variants on disk so a rejected one can be reconsidered, and nothing ever
 * removes them — a day of generating leaves sixty files and 63 MB of which the sequence uses two.
 *
 * Every assertion here is about *not* deleting something. A file wrongly called unused is a file the
 * user loses, and the document is the only thing that knows the difference.
 */

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

function videoClip(id: string, asset: string): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(60)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(asset), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
  };
}

function audioClip(id: string, asset: string): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(60)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(asset), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
  };
}

function documentWith(clips: readonly Clip[], masks: readonly MaskDefinition[] = []): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });

  return {
    ...base,
    masks,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) => {
        const mine = clips.filter((clip) => clip.kind === track.kind);
        return mine.length > 0 ? ({ ...track, clips: mine } as typeof track) : track;
      }),
    },
  };
}

const take = (name: string, sizeBytes = 1_000_000) => ({
  path: assetPath(`generated/${name}`),
  sizeBytes,
});

describe('what the document is using', () => {
  it('counts a clip´s source', () => {
    const document = documentWith([videoClip('c1', 'generated/kept.mp4')]);
    expect(referencedAssets(document).has('generated/kept.mp4')).toBe(true);
  });

  it('counts a mask´s asset, which is cache the document names', () => {
    // Removing one leaves an effect bound to a mask that no longer exists.
    const mask: MaskDefinition = {
      id: maskId('m1'),
      clip: clipId('c1'),
      span: spanFromBounds(frameIndex(0), frameIndex(60)),
      asset: assetPath('masks/m1.bin'),
      points: [],
    };
    expect(referencedAssets(documentWith([], [mask])).has('masks/m1.bin')).toBe(true);
  });

  it('is empty for a sequence of titles, which are drawn rather than read', () => {
    expect(referencedAssets(documentWith([])).size).toBe(0);
  });
});

describe('finding what nothing uses', () => {
  it('keeps a take that is on the timeline', () => {
    const document = documentWith([videoClip('c1', 'generated/kept.mp4')]);
    const result = findUnusedTakes(document, [take('kept.mp4'), take('spare.mp4')]);

    expect(result.unused.map((entry) => entry.path)).toEqual(['generated/spare.mp4']);
    expect(result.usedCount).toBe(1);
  });

  it('keeps one used by an audio clip as well as a video one', () => {
    const document = documentWith([audioClip('a1', 'generated/bed.flac')]);
    expect(findUnusedTakes(document, [take('bed.flac')]).unused).toEqual([]);
  });

  it('adds up what removing them would reclaim', () => {
    // A confirmation that cannot state the cost is a confirmation nobody can weigh.
    const result = findUnusedTakes(documentWith([]), [take('a.flac', 300), take('b.flac', 700)]);
    expect(result.bytes).toBe(1000);
  });

  it('finds nothing when every candidate is in use', () => {
    const document = documentWith([videoClip('c1', 'generated/one.mp4')]);
    const result = findUnusedTakes(document, [take('one.mp4')]);

    expect(result.unused).toEqual([]);
    expect(result.bytes).toBe(0);
  });

  it('reports nothing when asked about nothing', () => {
    expect(findUnusedTakes(documentWith([]), []).unused).toEqual([]);
  });

  it('answers only about the candidates it was given', () => {
    // The safety property: this cannot propose removing a file it was never told about, so the shell
    // decides what is eligible — files under `generated/` that carry a provenance record — and this
    // decides only which of those the document still needs.
    const document = documentWith([videoClip('c1', 'media/interview.mp4')]);
    const result = findUnusedTakes(document, [take('take.flac')]);

    expect(result.unused.map((entry) => entry.path)).toEqual(['generated/take.flac']);
  });
});
