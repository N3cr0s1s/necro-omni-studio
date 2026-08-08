import { describe, expect, it } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type VideoTrack,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  endExclusive,
  frameIndex,
  projectId,
  renderRange,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import {
  addMarker,
  clearWorkRange,
  markIn,
  markOut,
  markerAfter,
  markerBefore,
  removeMarker,
  setWorkRange,
} from './range-ops.js';

/**
 * In/out marks and markers.
 *
 * The interesting cases are all conflicts: marking in past the out point, marking out before the in
 * point, and marking on a document that has no range yet. What the range *does* — bound playback,
 * default the export, contribute snap candidates — is settled elsewhere; what it means when a user
 * contradicts themselves is settled here.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function clipOf(id: string, start: number, end: number): Clip {
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
    },
    transform,
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

function makeDocument(clips: readonly Clip[] = [clipOf('a', 0, 300)]): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
  const v1: VideoTrack = {
    ...(base.sequence.tracks[0] as VideoTrack),
    clips: clips as VideoTrack['clips'],
  };
  return {
    ...base,
    sequence: { ...base.sequence, tracks: [v1, ...base.sequence.tracks.slice(1)] },
  };
}

function bounds(document: TimelineDocument): [number, number] | undefined {
  const range = document.sequence.workRange;
  return range === undefined ? undefined : [range.start, endExclusive(range)];
}

describe('the first mark', () => {
  it('runs from the in point to the end of the sequence', () => {
    // "Render from here on" is nearly always what marking in alone means; a one-frame range would
    // have to be widened by hand every single time.
    const result = markIn(makeDocument(), frameIndex(100));
    expect(result.ok).toBe(true);
    expect(bounds(result.ok ? result.value.document : makeDocument())).toEqual([100, 300]);
  });

  it('runs from the start when only an out point is marked', () => {
    const result = markOut(makeDocument(), frameIndex(120));
    expect(bounds(result.ok ? result.value.document : makeDocument())).toEqual([0, 121]);
  });

  it('still produces a range past the end of the material', () => {
    // Marking in beyond every clip is legitimate — the user is about to put something there.
    const result = markIn(makeDocument(), frameIndex(900));
    expect(bounds(result.ok ? result.value.document : makeDocument())).toEqual([900, 901]);
  });
});

describe('the out point includes its frame', () => {
  it('covers the frame under the playhead', () => {
    // Half-open spans are an internal convention; an editor marking out on frame 120 means frame 120
    // is in the render.
    const result = markOut(makeDocument(), frameIndex(120));
    const range = result.ok ? result.value.range : undefined;
    expect(range && endExclusive(range)).toBe(121);
    expect(range?.duration).toBe(121);
  });
});

describe('conflicting marks', () => {
  const ranged = () => {
    const first = markIn(makeDocument(), frameIndex(100));
    if (!first.ok) throw new Error('unreachable');
    const second = markOut(first.value.document, frameIndex(200));
    if (!second.ok) throw new Error('unreachable');
    return second.value.document;
  };

  it('pushes the out point when the in point passes it', () => {
    // Moving a range forward is done by re-marking in; refusing the mark would make the user clear
    // the range first, every time.
    const result = markIn(ranged(), frameIndex(500));
    expect(result.ok && result.value.outcome).toEqual({ kind: 'pushed', other: 501 });
    expect(bounds(result.ok ? result.value.document : ranged())).toEqual([500, 501]);
  });

  it('pulls the in point when the out point precedes it', () => {
    const result = markOut(ranged(), frameIndex(40));
    expect(result.ok && result.value.outcome).toEqual({ kind: 'pushed', other: 40 });
    expect(bounds(result.ok ? result.value.document : ranged())).toEqual([40, 41]);
  });

  it('reports an ordinary mark as set, not as pushed', () => {
    const result = markIn(ranged(), frameIndex(150));
    expect(result.ok && result.value.outcome).toEqual({ kind: 'set' });
  });

  it('never leaves a range with no frames', () => {
    for (const frame of [0, 1, 100, 200, 201, 5000]) {
      const marked = markIn(ranged(), frameIndex(frame));
      expect(marked.ok && marked.value.range.duration).toBeGreaterThan(0);
      const out = markOut(ranged(), frameIndex(frame));
      expect(out.ok && out.value.range.duration).toBeGreaterThan(0);
    }
  });
});

describe('clearing', () => {
  it('removes the range rather than widening it to the content', () => {
    // A stored range that happens to match the material would silently stop tracking it as clips are
    // added, which looks like the export truncating for no reason.
    const marked = markIn(makeDocument(), frameIndex(50));
    const cleared = clearWorkRange(marked.ok ? marked.value.document : makeDocument());

    expect(cleared.sequence.workRange).toBeUndefined();
    expect('workRange' in cleared.sequence).toBe(false);
  });

  it('is a no-op on a document with no range', () => {
    const document = makeDocument();
    expect(clearWorkRange(document)).toBe(document);
  });

  it('hands the render range back to the whole sequence', () => {
    const marked = setWorkRange(makeDocument(), spanFromBounds(frameIndex(10), frameIndex(20)));
    const document = clearWorkRange(marked.ok ? marked.value.document : makeDocument());
    expect(renderRange(document).duration).toBe(300);
  });
});

describe('what the range feeds', () => {
  it('becomes the render range, which is what export uses', () => {
    const marked = markIn(makeDocument(), frameIndex(100));
    const range = renderRange(marked.ok ? marked.value.document : makeDocument());
    expect([range.start, endExclusive(range)]).toEqual([100, 300]);
  });
});

describe('markers', () => {
  const marker = (frame: number, label: string) => ({ frame: frameIndex(frame), label });

  it('keeps them in frame order, so nothing has to sort to draw', () => {
    let document = addMarker(makeDocument(), marker(200, 'b'));
    document = addMarker(document, marker(50, 'a'));
    document = addMarker(document, marker(120, 'c'));

    expect(document.sequence.markers.map((m) => m.frame)).toEqual([50, 120, 200]);
  });

  it('replaces one on the same frame instead of stacking', () => {
    // Two markers on one frame draw on top of each other; the second is only discoverable by
    // deleting the first.
    let document = addMarker(makeDocument(), marker(50, 'first'));
    document = addMarker(document, marker(50, 'second'));

    expect(document.sequence.markers).toHaveLength(1);
    expect(document.sequence.markers[0]?.label).toBe('second');
  });

  it('removes by frame', () => {
    const document = removeMarker(addMarker(makeDocument(), marker(50, 'a')), frameIndex(50));
    expect(document.sequence.markers).toEqual([]);
  });

  it('is unchanged when removing a frame with no marker', () => {
    const document = addMarker(makeDocument(), marker(50, 'a'));
    expect(removeMarker(document, frameIndex(51))).toBe(document);
  });
});

describe('marker navigation', () => {
  const populated = () => {
    let document = makeDocument();
    for (const [frame, label] of [
      [10, 'a'],
      [80, 'b'],
      [200, 'c'],
    ] as const) {
      document = addMarker(document, { frame: frameIndex(frame), label });
    }
    return document;
  };

  it('finds the nearest marker before a frame', () => {
    expect(markerBefore(populated(), frameIndex(150))?.label).toBe('b');
  });

  it('finds the nearest marker after a frame', () => {
    expect(markerAfter(populated(), frameIndex(150))?.label).toBe('c');
  });

  it('never jumps backwards when asked to go forward', () => {
    // Navigation that occasionally does nothing is better than navigation that moves the wrong way.
    expect(markerAfter(populated(), frameIndex(200))).toBeUndefined();
    expect(markerBefore(populated(), frameIndex(10))).toBeUndefined();
  });

  it('does not treat the marker under the playhead as a destination', () => {
    // Otherwise "next marker" pressed twice would sit on the same one forever.
    expect(markerAfter(populated(), frameIndex(80))?.label).toBe('c');
    expect(markerBefore(populated(), frameIndex(80))?.label).toBe('a');
  });
});
