import { describe, expect, it } from 'vitest';
import {
  type TimelineDocument,
  type Track,
  type VideoClip,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  endExclusive,
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { FRAME_BATCH_BYTES, defaultRange, describeTiming } from './use-export.js';

/**
 * Export helpers.
 *
 * The batching constant and the timing summary look like details, and both are load-bearing: the first
 * decides how many frames sit in memory at once, and the second is what turned "the export is slow"
 * from a guess into a measurement that refuted two confident hypotheses in a row.
 */

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

function videoClip(id: string, start: number, end: number): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/x.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
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

function documentWith(clips: readonly VideoClip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'P',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.id === TRACKS.video ? ({ ...track, clips } as Track) : track,
      ),
    },
  };
}

describe('the default range', () => {
  it('covers everything on the timeline', () => {
    const range = defaultRange(documentWith([videoClip('a', 0, 100), videoClip('b', 100, 250)]));
    expect(range.start).toBe(0);
    expect(endExclusive(range)).toBe(250);
  });

  it('reaches the furthest clip, not the last one in the list', () => {
    // Clips are not stored in timeline order after a move, and an export that stopped at the last
    // *listed* clip would silently truncate the delivery.
    const range = defaultRange(documentWith([videoClip('b', 200, 300), videoClip('a', 0, 100)]));
    expect(endExclusive(range)).toBe(300);
  });

  it('is empty for an empty sequence rather than a guess', () => {
    const range = defaultRange(documentWith([]));
    expect(endExclusive(range)).toBe(0);
  });

  it('starts at zero, because an export is of the sequence and not of a selection', () => {
    expect(defaultRange(documentWith([videoClip('a', 90, 120)])).start).toBe(0);
  });
});

describe('the frame batch size', () => {
  it('holds at least one 1080p frame', () => {
    // A batch smaller than a frame could never be sent.
    expect(FRAME_BATCH_BYTES).toBeGreaterThanOrEqual(1920 * 1080 * 4);
  });

  it('stays small enough that two in flight is not a memory problem', () => {
    // One batch is being built while another uploads, so the resident cost is twice this.
    expect(FRAME_BATCH_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});

describe('the timing summary', () => {
  const timing = {
    decodeMs: 300,
    renderMs: 100,
    readbackMs: 200,
    uploadMs: 400,
    totalMs: 1000,
    frames: 30,
  };

  it('reports each stage as a share of the run', () => {
    const summary = describeTiming(timing);
    expect(summary).toContain('decode 30%');
    expect(summary).toContain('render 10%');
    expect(summary).toContain('readback 20%');
    expect(summary).toContain('upload 40%');
  });

  it('leads with what was actually done, so the shares have a scale', () => {
    expect(describeTiming(timing)).toContain('30 frames in 1.0 s');
  });

  it('survives a run too fast to measure', () => {
    // A zero total would divide by zero and print NaN, which is worse than a meaningless 0%.
    const instant = { ...timing, totalMs: 0, decodeMs: 0, renderMs: 0, readbackMs: 0, uploadMs: 0 };
    expect(describeTiming(instant)).not.toContain('NaN');
  });

  it('lets the shares exceed 100%, because the upload overlaps the render', () => {
    // Not a bug to be normalised away: it is the visible evidence that pipelining works, and forcing
    // the numbers to sum would hide exactly the thing worth seeing.
    const overlapped = { ...timing, uploadMs: 950, totalMs: 1000 };
    expect(describeTiming(overlapped)).toContain('upload 95%');
  });
});
