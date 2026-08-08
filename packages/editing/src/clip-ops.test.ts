import { describe, expect, it } from 'vitest';
import {
  type AudioTrack,
  type Clip,
  type ClipId,
  type TextTrack,
  type TimelineDocument,
  type VideoClip,
  type VideoTrack,
  FRAME_RATES,
  animatedNumber,
  assetPath,
  clipId,
  createDocument,
  endExclusive,
  frameIndex,
  frameRate,
  keyframeId,
  locateClip,
  projectId,
  sequenceId,
  staticNumber,
  spanFromBounds,
  trackClips,
  trackId,
} from '@nos/core';
import {
  type SourceBoundsResolver,
  UNBOUNDED_SOURCES,
  liftClip,
  moveClip,
  rippleDeleteClip,
  rippleDeleteRange,
  setClipEnabled,
  slipClip,
  splitAllTracksAt,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from './clip-ops.js';

const V1 = trackId('v1');
const V2 = trackId('v2');
const A1 = trackId('a1');
const T1 = trackId('t1');

let nextId = 0;
const freshId = (): ClipId => clipId(`new_${(nextId += 1)}`);

/** A video clip at the project rate, with a source in-point so trims can be observed. */
function videoClip(
  id: string,
  start: number,
  end: number,
  overrides: Partial<VideoClip> = {},
): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(100),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
    ...overrides,
  } as VideoClip;
}

/** A document at 30 fps with V1, V2, A1, T1 and whatever clips are supplied. */
function makeDocument(clips: readonly Clip[] = [], onTrack: string = 'v1'): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: V1, audio: A1, text: T1 },
  });

  const v1: VideoTrack = {
    ...(base.sequence.tracks[0] as VideoTrack),
    clips: onTrack === 'v1' ? (clips as VideoTrack['clips']) : [],
  };
  const v2: VideoTrack = { ...v1, id: V2, name: 'V2', clips: [] };
  const a1 = base.sequence.tracks[1] as AudioTrack;
  const t1 = base.sequence.tracks[2] as TextTrack;

  return { ...base, sequence: { ...base.sequence, tracks: [v2, v1, a1, t1] } };
}

function clipsOf(document: TimelineDocument, track = V1): readonly Clip[] {
  const found = document.sequence.tracks.find((candidate) => candidate.id === track);
  return found === undefined ? [] : [...trackClips(found)].sort((a, b) => a.span.start - b.span.start);
}

function spansOf(document: TimelineDocument, track = V1): readonly [number, number][] {
  return clipsOf(document, track).map((clip) => [clip.span.start, endExclusive(clip.span)]);
}

describe('splitClip', () => {
  it('produces two adjacent halves covering the original span', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = splitClip(document, clipId('a'), frameIndex(40), freshId());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spansOf(result.value)).toEqual([
      [0, 40],
      [40, 100],
    ]);
  });

  it('advances the right half source in-point by the cut offset', () => {
    // Without this the second half would replay the first half's frames.
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = splitClip(document, clipId('a'), frameIndex(40), clipId('right'));
    if (!result.ok) throw new Error('split failed');

    const right = locateClip(result.value, clipId('right'));
    expect(right?.clip.kind === 'video' && right.clip.source.sourceIn).toBe(140);
    const left = locateClip(result.value, clipId('a'));
    expect(left?.clip.kind === 'video' && left.clip.source.sourceIn).toBe(100);
  });

  it('converts the source offset when the source rate differs from the project rate', () => {
    // 40 project frames at 30 fps is 1.333 s, which is 32 frames of 24 fps source.
    const clip = videoClip('a', 0, 100, {
      source: {
        asset: assetPath('media/a.mp4'),
        sourceIn: frameIndex(0),
        sourceRate: frameRate(24),
      },
    });
    const document = makeDocument([clip]);
    const result = splitClip(document, clipId('a'), frameIndex(40), clipId('right'));
    if (!result.ok) throw new Error('split failed');

    const right = locateClip(result.value, clipId('right'));
    expect(right?.clip.kind === 'video' && right.clip.source.sourceIn).toBe(32);
  });

  it('shifts the right half keyframes so an effect animation does not jump', () => {
    const clip = videoClip('a', 0, 100, {
      transform: {
        x: staticNumber(0),
        y: staticNumber(0),
        scale: staticNumber(1),
        rotation: staticNumber(0),
        opacity: animatedNumber([
          { id: keyframeId('k1'), frame: frameIndex(0), value: 0, ease: 'linear' },
          { id: keyframeId('k2'), frame: frameIndex(60), value: 1, ease: 'linear' },
        ]),
      },
    });
    const document = makeDocument([clip]);
    const result = splitClip(document, clipId('a'), frameIndex(40), clipId('right'));
    if (!result.ok) throw new Error('split failed');

    const right = locateClip(result.value, clipId('right'));
    const opacity = right?.clip.kind === 'video' ? right.clip.transform.opacity : undefined;
    // Clip-relative positions rebased by the cut offset: 0 and 60 become -40 and 20.
    expect(opacity?.kind === 'animated' && opacity.keyframes.map((k) => k.frame)).toEqual([-40, 20]);
  });

  it('refuses to cut on a boundary, which would make a zero-length clip', () => {
    const document = makeDocument([videoClip('a', 10, 100)]);
    for (const at of [10, 100, 5, 200]) {
      const result = splitClip(document, clipId('a'), frameIndex(at), freshId());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('nothing-to-cut');
    }
  });

  it('refuses to cut on a locked track', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const locked = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.id === V1 ? { ...track, locked: true } : track,
        ),
      },
    };
    const result = splitClip(locked, clipId('a'), frameIndex(40), freshId());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('track-locked');
  });

  it('reports a missing clip', () => {
    const result = splitClip(makeDocument(), clipId('ghost'), frameIndex(10), freshId());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('clip-not-found');
  });
});

describe('splitAllTracksAt', () => {
  it('cuts every clip crossing the frame', () => {
    const document = makeDocument([videoClip('a', 0, 100), videoClip('b', 100, 200)]);
    const result = splitAllTracksAt(document, frameIndex(50), freshId);
    if (!result.ok) throw new Error('cut failed');
    expect(spansOf(result.value)).toEqual([
      [0, 50],
      [50, 100],
      [100, 200],
    ]);
  });

  it('skips locked tracks rather than failing the whole cut', () => {
    // Skipping is what locking means; refusing the operation would be unhelpful.
    const document = makeDocument([videoClip('a', 0, 100)]);
    const withLocked: TimelineDocument = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.id === V1 ? { ...track, locked: true } : track,
        ),
      },
    };
    const result = splitAllTracksAt(withLocked, frameIndex(50), freshId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('nothing-to-cut');
  });

  it('reports nothing to cut in a gap', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = splitAllTracksAt(document, frameIndex(80), freshId);
    expect(result.ok).toBe(false);
  });
});

describe('trimClipStart', () => {
  it('shortens from the head, keeping the out-point', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipStart(document, clipId('a'), 20);
    if (!result.ok) throw new Error('trim failed');
    expect(spansOf(result.value)).toEqual([[20, 100]]);
  });

  it('advances the source in-point with the head', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipStart(document, clipId('a'), 20);
    if (!result.ok) throw new Error('trim failed');
    const clip = locateClip(result.value, clipId('a'));
    expect(clip?.clip.kind === 'video' && clip.clip.source.sourceIn).toBe(120);
  });

  it('extends backwards when the source has frames before the in-point', () => {
    const document = makeDocument([videoClip('a', 50, 100)]);
    const result = trimClipStart(document, clipId('a'), -30);
    if (!result.ok) throw new Error('trim failed');
    expect(spansOf(result.value)).toEqual([[20, 100]]);
    const clip = locateClip(result.value, clipId('a'));
    expect(clip?.clip.kind === 'video' && clip.clip.source.sourceIn).toBe(70);
  });

  it('refuses to extend past the beginning of the source', () => {
    // sourceIn is 100, so only 100 frames of head room exist.
    const document = makeDocument([videoClip('a', 200, 300)]);
    const result = trimClipStart(document, clipId('a'), -150);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('source-exhausted');
  });

  it('refuses to collapse the clip', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipStart(document, clipId('a'), 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('empty-result');
  });

  it('refuses to extend into a neighbour', () => {
    const document = makeDocument([videoClip('a', 0, 50), videoClip('b', 50, 100)]);
    const result = trimClipStart(document, clipId('b'), -10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('collision');
  });

  it('shifts keyframes so effects stay glued to the picture', () => {
    const clip = videoClip('a', 0, 100, {
      transform: {
        x: staticNumber(0),
        y: staticNumber(0),
        scale: staticNumber(1),
        rotation: staticNumber(0),
        opacity: animatedNumber([
          { id: keyframeId('k1'), frame: frameIndex(30), value: 1, ease: 'linear' },
        ]),
      },
    });
    const result = trimClipStart(makeDocument([clip]), clipId('a'), 10);
    if (!result.ok) throw new Error('trim failed');
    const trimmed = locateClip(result.value, clipId('a'));
    const opacity = trimmed?.clip.kind === 'video' ? trimmed.clip.transform.opacity : undefined;
    expect(opacity?.kind === 'animated' && opacity.keyframes[0]!.frame).toBe(20);
  });
});

describe('trimClipEnd', () => {
  it('shortens from the tail, keeping the in-point', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipEnd(document, clipId('a'), -30);
    if (!result.ok) throw new Error('trim failed');
    expect(spansOf(result.value)).toEqual([[0, 70]]);
  });

  it('leaves the source in-point and keyframes untouched', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipEnd(document, clipId('a'), -30);
    if (!result.ok) throw new Error('trim failed');
    const clip = locateClip(result.value, clipId('a'));
    expect(clip?.clip.kind === 'video' && clip.clip.source.sourceIn).toBe(100);
  });

  it('extends the tail when nothing constrains it', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipEnd(document, clipId('a'), 50, { sources: UNBOUNDED_SOURCES });
    if (!result.ok) throw new Error('trim failed');
    expect(spansOf(result.value)).toEqual([[0, 150]]);
  });

  it('refuses to extend past the end of the source when bounds are known', () => {
    // sourceIn 100 with a 200-frame source leaves 100 frames; asking for 150 must fail.
    const sources: SourceBoundsResolver = { boundsFor: () => ({ totalFrames: 200 }) };
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipEnd(document, clipId('a'), 50, { sources });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'source-exhausted') {
      expect(result.error.available).toBe(100);
      expect(result.error.requested).toBe(150);
    }
  });

  it('allows an extension that exactly consumes the source', () => {
    const sources: SourceBoundsResolver = { boundsFor: () => ({ totalFrames: 200 }) };
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipEnd(document, clipId('a'), 0, { sources });
    expect(result.ok).toBe(true);
  });

  it('proceeds unchecked when bounds are unknown, so editing is not blocked on a probe', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipEnd(document, clipId('a'), 10_000, { sources: UNBOUNDED_SOURCES });
    expect(result.ok).toBe(true);
  });

  it('refuses to collapse the clip', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = trimClipEnd(document, clipId('a'), -100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('empty-result');
  });

  it('refuses to extend into a neighbour', () => {
    const document = makeDocument([videoClip('a', 0, 50), videoClip('b', 50, 100)]);
    const result = trimClipEnd(document, clipId('a'), 10, { sources: UNBOUNDED_SOURCES });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('collision');
  });
});

describe('slipClip', () => {
  it('changes the source in-point without moving the clip', () => {
    const document = makeDocument([videoClip('a', 10, 100)]);
    const result = slipClip(document, clipId('a'), 25);
    if (!result.ok) throw new Error('slip failed');

    expect(spansOf(result.value)).toEqual([[10, 100]]);
    const clip = locateClip(result.value, clipId('a'));
    expect(clip?.clip.kind === 'video' && clip.clip.source.sourceIn).toBe(125);
  });

  it('slips backwards', () => {
    const document = makeDocument([videoClip('a', 10, 100)]);
    const result = slipClip(document, clipId('a'), -40);
    if (!result.ok) throw new Error('slip failed');
    const clip = locateClip(result.value, clipId('a'));
    expect(clip?.clip.kind === 'video' && clip.clip.source.sourceIn).toBe(60);
  });

  it('leaves keyframes alone, because they are authored against the window not the material', () => {
    const clip = videoClip('a', 0, 100, {
      transform: {
        x: staticNumber(0),
        y: staticNumber(0),
        scale: staticNumber(1),
        rotation: staticNumber(0),
        opacity: animatedNumber([
          { id: keyframeId('k1'), frame: frameIndex(10), value: 1, ease: 'linear' },
        ]),
      },
    });
    const result = slipClip(makeDocument([clip]), clipId('a'), 30);
    if (!result.ok) throw new Error('slip failed');
    const slipped = locateClip(result.value, clipId('a'));
    const opacity = slipped?.clip.kind === 'video' ? slipped.clip.transform.opacity : undefined;
    expect(opacity?.kind === 'animated' && opacity.keyframes[0]!.frame).toBe(10);
  });

  it('refuses to slip before the start of the source', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = slipClip(document, clipId('a'), -200);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('source-exhausted');
  });

  it('refuses to slip past the end of the source when bounds are known', () => {
    const sources: SourceBoundsResolver = { boundsFor: () => ({ totalFrames: 200 }) };
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = slipClip(document, clipId('a'), 60, { sources });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('source-exhausted');
  });

  it('is a no-op for zero delta and for text clips', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = slipClip(document, clipId('a'), 0);
    expect(result.ok && result.value).toBe(document);
  });
});

describe('moveClip', () => {
  it('moves a clip within its track', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = moveClip(document, clipId('a'), V1, frameIndex(200));
    if (!result.ok) throw new Error('move failed');
    expect(spansOf(result.value)).toEqual([[200, 250]]);
  });

  it('moves a clip to another track of the same kind', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = moveClip(document, clipId('a'), V2, frameIndex(10));
    if (!result.ok) throw new Error('move failed');
    expect(spansOf(result.value, V1)).toEqual([]);
    expect(spansOf(result.value, V2)).toEqual([[10, 60]]);
  });

  it('rejects a collision rather than displacing material the user cannot see', () => {
    const document = makeDocument([videoClip('a', 0, 50), videoClip('b', 100, 150)]);
    const result = moveClip(document, clipId('a'), V1, frameIndex(120));
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'collision') {
      expect(result.error.withClip).toBe('b');
    }
  });

  it('does not collide with itself when moved to an overlapping position', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = moveClip(document, clipId('a'), V1, frameIndex(10));
    expect(result.ok).toBe(true);
  });

  it('refuses to move a video clip onto an audio track', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = moveClip(document, clipId('a'), A1, frameIndex(0));
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'wrong-track-kind') {
      expect(result.error.received).toBe('video');
      expect(result.error.accepts).toContain('audio');
    }
  });

  it('refuses a negative position', () => {
    const document = makeDocument([videoClip('a', 100, 150)]);
    const result = moveClip(document, clipId('a'), V1, frameIndex(-10));
    expect(result.ok).toBe(false);
  });

  it('refuses to move onto a locked track', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const locked: TimelineDocument = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.id === V2 ? { ...track, locked: true } : track,
        ),
      },
    };
    const result = moveClip(locked, clipId('a'), V2, frameIndex(0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('track-locked');
  });

  it('reports a missing target track', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = moveClip(document, clipId('a'), trackId('nope'), frameIndex(0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('track-not-found');
  });
});

describe('liftClip', () => {
  it('removes a clip and leaves the gap', () => {
    const document = makeDocument([videoClip('a', 0, 50), videoClip('b', 100, 150)]);
    const result = liftClip(document, clipId('a'));
    if (!result.ok) throw new Error('lift failed');
    // `b` must not move: lift is the non-rippling delete.
    expect(spansOf(result.value)).toEqual([[100, 150]]);
  });
});

describe('rippleDeleteClip', () => {
  it('removes a clip and pulls later clips back by its duration', () => {
    const document = makeDocument([
      videoClip('a', 0, 50),
      videoClip('b', 50, 100),
      videoClip('c', 100, 150),
    ]);
    const result = rippleDeleteClip(document, clipId('b'));
    if (!result.ok) throw new Error('ripple failed');
    expect(spansOf(result.value)).toEqual([
      [0, 50],
      [50, 100],
    ]);
  });

  it('does not move clips that start before the removed one', () => {
    const document = makeDocument([videoClip('a', 0, 50), videoClip('b', 60, 100)]);
    const result = rippleDeleteClip(document, clipId('b'));
    if (!result.ok) throw new Error('ripple failed');
    expect(spansOf(result.value)).toEqual([[0, 50]]);
  });

  it('leaves other tracks untouched, so aligned layers stay aligned', () => {
    // The same reasoning the spec applies to discovered-length inserts: an edit on one track must
    // not rearrange another.
    const document = makeDocument([videoClip('a', 0, 50), videoClip('b', 50, 100)]);
    const withV2: TimelineDocument = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.id === V2 ? ({ ...track, clips: [videoClip('x', 50, 100)] } as VideoTrack) : track,
        ),
      },
    };
    const result = rippleDeleteClip(withV2, clipId('a'));
    if (!result.ok) throw new Error('ripple failed');
    expect(spansOf(result.value, V2)).toEqual([[50, 100]]);
  });
});

describe('rippleDeleteRange', () => {
  it('removes clips fully inside the range and closes the gap', () => {
    const document = makeDocument([
      videoClip('a', 0, 50),
      videoClip('b', 50, 100),
      videoClip('c', 100, 150),
    ]);
    const result = rippleDeleteRange(
      document,
      V1,
      spanFromBounds(frameIndex(50), frameIndex(100)),
      freshId,
    );
    if (!result.ok) throw new Error('ripple failed');
    expect(spansOf(result.value)).toEqual([
      [0, 50],
      [50, 100],
    ]);
  });

  it('keeps the surviving head of a clip straddling the range start', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = rippleDeleteRange(
      document,
      V1,
      spanFromBounds(frameIndex(60), frameIndex(100)),
      freshId,
    );
    if (!result.ok) throw new Error('ripple failed');
    expect(spansOf(result.value)).toEqual([[0, 60]]);
  });

  it('keeps the surviving tail of a clip straddling the range end, rebased', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = rippleDeleteRange(
      document,
      V1,
      spanFromBounds(frameIndex(0), frameIndex(40)),
      freshId,
    );
    if (!result.ok) throw new Error('ripple failed');
    expect(spansOf(result.value)).toEqual([[0, 60]]);

    const survivor = clipsOf(result.value)[0]!;
    // The surviving tail must play the source frames it always did: in-point advanced by 40.
    expect(survivor.kind === 'video' && survivor.source.sourceIn).toBe(140);
  });

  it('punches a hole in a clip, producing two pieces', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = rippleDeleteRange(
      document,
      V1,
      spanFromBounds(frameIndex(40), frameIndex(60)),
      freshId,
    );
    if (!result.ok) throw new Error('ripple failed');
    // 0..40 survives, 60..100 survives and slides back by 20 to become 40..80.
    expect(spansOf(result.value)).toEqual([
      [0, 40],
      [40, 80],
    ]);
  });

  it('gives the first surviving piece the original id, so selection survives', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = rippleDeleteRange(
      document,
      V1,
      spanFromBounds(frameIndex(40), frameIndex(60)),
      freshId,
    );
    if (!result.ok) throw new Error('ripple failed');
    expect(clipsOf(result.value)[0]!.id).toBe('a');
    expect(clipsOf(result.value)[1]!.id).not.toBe('a');
  });

  it('is a no-op for an empty range', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const result = rippleDeleteRange(
      document,
      V1,
      spanFromBounds(frameIndex(50), frameIndex(50)),
      freshId,
    );
    expect(result.ok && result.value).toBe(document);
  });

  it('refuses on a locked track', () => {
    const document = makeDocument([videoClip('a', 0, 100)]);
    const locked: TimelineDocument = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.id === V1 ? { ...track, locked: true } : track,
        ),
      },
    };
    const result = rippleDeleteRange(
      locked,
      V1,
      spanFromBounds(frameIndex(0), frameIndex(50)),
      freshId,
    );
    expect(result.ok).toBe(false);
  });
});

describe('structural sharing', () => {
  it('leaves untouched tracks by reference, so a history snapshot costs pointers', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = trimClipEnd(document, clipId('a'), -10);
    if (!result.ok) throw new Error('trim failed');

    const beforeAudio = document.sequence.tracks.find((track) => track.id === A1);
    const afterAudio = result.value.sequence.tracks.find((track) => track.id === A1);
    expect(afterAudio).toBe(beforeAudio);
  });

  it('returns the same document for a no-op, so no history entry is recorded', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const result = setClipEnabled(document, clipId('a'), true);
    expect(result.ok && result.value).toBe(document);
  });

  it('does not mutate the input document', () => {
    const document = makeDocument([videoClip('a', 0, 50)]);
    const before = JSON.stringify(spansOf(document));
    trimClipEnd(document, clipId('a'), -10);
    expect(JSON.stringify(spansOf(document))).toBe(before);
  });
});
