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
import { moveClips } from './move-many.js';

/**
 * Moving several clips at once.
 *
 * The reason this is not a loop over `moveClip`: applied one at a time, each move collides with the
 * clips that have not moved yet, so shifting a run of adjacent clips would refuse at the first one.
 * Every test here is really about that — the set has to be considered together.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, end: number): Clip {
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
  } as Clip;
}

function audio(id: string, start: number, end: number): AudioClip {
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
  } as AudioClip;
}

function documentWith(clips: readonly Clip[], audioClips: readonly AudioClip[] = []): TimelineDocument {
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
        if (track.kind === 'video' && clips.length > 0) return { ...track, clips } as Track;
        if (track.kind === 'audio' && audioClips.length > 0) return { ...track, clips: audioClips } as Track;
        return track;
      }),
    },
  };
}

/** Clip positions as `id@start`, in timeline order. */
function positions(document: TimelineDocument): readonly string[] {
  return document.sequence.tracks
    .flatMap((track) => track.clips.map((clip) => ({ id: clip.id as string, start: clip.span.start })))
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))
    .map((entry) => `${entry.id}@${entry.start}`);
}

const ids = (...names: string[]) => names.map((name) => clipId(name));

describe('moving a set', () => {
  it('shifts a run of adjacent clips, which one-at-a-time cannot', () => {
    // The whole reason this operation exists: applied singly, `a` would collide with `b`, which is
    // still where it was.
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    const result = moveClips(document, ids('a', 'b'), 50);

    expect(result.ok && positions(result.value.document)).toEqual(['a@50', 'b@150']);
  });

  it('keeps the spacing between them', () => {
    const document = documentWith([video('a', 0, 100), video('b', 300, 400)]);
    const result = moveClips(document, ids('a', 'b'), 100);

    expect(result.ok && positions(result.value.document)).toEqual(['a@100', 'b@400']);
  });

  it('moves clips on different tracks together', () => {
    const document = documentWith([video('v', 0, 100)], [audio('m', 0, 100)]);
    const result = moveClips(document, ids('v', 'm'), 200);

    expect(result.ok && positions(result.value.document)).toEqual(['m@200', 'v@200']);
  });

  it('moves backwards as readily as forwards', () => {
    const document = documentWith([video('a', 500, 600)]);
    const result = moveClips(document, ids('a'), -200);

    expect(result.ok && positions(result.value.document)).toEqual(['a@300']);
  });
});

describe('the start of the timeline', () => {
  it('stops at frame zero rather than refusing the drag', () => {
    // A drag that runs into the start should stop, which is what every editor does — not snap back
    // to where it began.
    const document = documentWith([video('a', 50, 150)]);
    const result = moveClips(document, ids('a'), -500);

    expect(result.ok && positions(result.value.document)).toEqual(['a@0']);
    expect(result.ok && result.value.deltaFrames).toBe(-50);
  });

  it('keeps the group together when it meets the start', () => {
    // Clamping each clip on its own would pile them all onto frame zero.
    const document = documentWith([video('a', 50, 100), video('b', 200, 300)]);
    const result = moveClips(document, ids('a', 'b'), -500);

    expect(result.ok && positions(result.value.document)).toEqual(['a@0', 'b@150']);
  });
});

describe('refusing', () => {
  it('refuses when the set would land on something outside it', () => {
    const document = documentWith([video('a', 0, 100), video('other', 200, 300)]);
    const result = moveClips(document, ids('a'), 150);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('collision');
  });

  it('is all or nothing, so alignment is never half preserved', () => {
    const document = documentWith([video('a', 0, 100), video('b', 300, 400), video('wall', 500, 600)]);
    const before = positions(document);
    const result = moveClips(document, ids('a', 'b'), 250);

    expect(result.ok).toBe(false);
    expect(positions(document)).toEqual(before);
  });

  it('refuses a locked track', () => {
    const base = documentWith([video('a', 0, 100)]);
    const locked: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.kind === 'video' ? ({ ...track, locked: true } as Track) : track,
        ),
      },
    };

    expect(moveClips(locked, ids('a'), 10).ok).toBe(false);
  });

  it('lets a selection move out of an overlap it did not create', () => {
    // Two clips already overlapping are the document's problem, not this move's. Reporting them
    // would make the mess impossible to escape.
    const document = documentWith([video('a', 0, 200), video('b', 100, 300)]);
    const result = moveClips(document, ids('a', 'b'), 500);

    expect(result.ok).toBe(true);
  });
});

describe('doing nothing', () => {
  it('returns the same document for a zero delta', () => {
    const document = documentWith([video('a', 0, 100)]);
    const result = moveClips(document, ids('a'), 0);
    expect(result.ok && result.value.document).toBe(document);
  });

  it('returns the same document for an empty set', () => {
    const document = documentWith([video('a', 0, 100)]);
    const result = moveClips(document, [], 100);
    expect(result.ok && result.value.document).toBe(document);
  });

  it('reports a clip that is not there', () => {
    const document = documentWith([video('a', 0, 100)]);
    expect(moveClips(document, ids('ghost'), 10).ok).toBe(false);
  });
});
