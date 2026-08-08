import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type AudioTrack,
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
  trackClips,
  trackId,
} from '@nos/core';
import { eligibleTracksFor } from './drag-target.js';
import { moveClipsBy } from './move-many.js';

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, end: number, extra: Record<string, unknown> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(`media/${id}.mp4`), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

function audio(id: string, start: number, end: number, extra: Record<string, unknown> = {}): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(`media/${id}.wav`), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...extra,
  } as AudioClip;
}

/** Two video rows and two audio rows, so a group has somewhere to go in both kinds. */
function documentWith(v1: readonly Clip[], a1: readonly AudioClip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

  const video1 = base.sequence.tracks.find((track) => track.kind === 'video') as VideoTrack;
  const audio1 = base.sequence.tracks.find((track) => track.kind === 'audio') as AudioTrack;
  const text1 = base.sequence.tracks.find((track) => track.kind === 'text');

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: [
        { ...video1, clips: v1 as VideoTrack['clips'] },
        { ...video1, id: trackId('v2'), name: 'V2', clips: [] },
        { ...audio1, clips: a1 as AudioTrack['clips'] },
        { ...audio1, id: trackId('a2'), name: 'A2', clips: [] },
        ...(text1 === undefined ? [] : [text1]),
      ],
    },
  };
}

const where = (document: TimelineDocument, clip: string) => {
  for (const track of document.sequence.tracks) {
    const found = trackClips(track).find((candidate) => candidate.id === clip);
    if (found !== undefined) return { track: track.id as string, start: found.span.start as number };
  }
  return undefined;
};

const move = (document: TimelineDocument, ids: readonly string[], frames: number, rows: number) =>
  moveClipsBy(document, ids.map(clipId), frames, rows, (clip) =>
    eligibleTracksFor(document.sequence.tracks, clip),
  );

describe('moving a group across rows', () => {
  it('takes a linked pair down together, each within its own kind', () => {
    // The case that made vertical movement useless: an imported video and its audio are linked, so
    // grabbing either drags both — and a group pinned to its tracks could never change row at all.
    const document = documentWith([video('v', 0, 100)], [audio('a', 0, 100)]);
    const result = move(document, ['v', 'a'], 0, 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(where(result.value.document, 'v')).toEqual({ track: 'v2', start: 0 });
    expect(where(result.value.document, 'a')).toEqual({ track: 'a2', start: 0 });
  });

  it('moves them in time and across rows in one operation', () => {
    const document = documentWith([video('v', 0, 100)], [audio('a', 0, 100)]);
    const result = move(document, ['v', 'a'], 200, 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(where(result.value.document, 'v')).toEqual({ track: 'v2', start: 200 });
    expect(where(result.value.document, 'a')).toEqual({ track: 'a2', start: 200 });
  });

  it('comes back up again', () => {
    const document = documentWith([video('v', 0, 100)], [audio('a', 0, 100)]);
    const down = move(document, ['v', 'a'], 0, 1);
    expect(down.ok).toBe(true);
    if (!down.ok) return;

    const up = moveClipsBy(down.value.document, [clipId('v'), clipId('a')], 0, -1, (clip) =>
      eligibleTracksFor(down.value.document.sequence.tracks, clip),
    );
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(where(up.value.document, 'v')?.track).toBe('v1');
    expect(where(up.value.document, 'a')?.track).toBe('a1');
  });

  it('clamps at the last row rather than refusing the whole drag', () => {
    // Running out of tracks should stop the vertical part of a gesture, not cancel it.
    const document = documentWith([video('v', 0, 100)], [audio('a', 0, 100)]);
    const result = move(document, ['v', 'a'], 60, 9);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(where(result.value.document, 'v')).toEqual({ track: 'v2', start: 60 });
    expect(where(result.value.document, 'a')).toEqual({ track: 'a2', start: 60 });
  });

  it('is the plain translation when no rows are crossed', () => {
    const document = documentWith([video('v', 0, 100)], [audio('a', 0, 100)]);
    const result = move(document, ['v', 'a'], 30, 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(where(result.value.document, 'v')).toEqual({ track: 'v1', start: 30 });
  });

  it('refuses when the destination row is occupied', () => {
    // All or nothing, like an in-track group move: a partial landing breaks exactly the alignment the
    // user was preserving by moving them together.
    const document = documentWith([video('v', 0, 100)], [audio('a', 0, 100)]);
    const occupied: TimelineDocument = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.id === 'v2' ? ({ ...track, clips: [video('blocker', 0, 100)] } as typeof track) : track,
        ),
      },
    };

    const result = moveClipsBy(occupied, [clipId('v'), clipId('a')], 0, 1, (clip) =>
      eligibleTracksFor(occupied.sequence.tracks, clip),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('collision');
  });

  it('keeps the spacing of a run of clips moving together', () => {
    const document = documentWith([video('one', 0, 100), video('two', 100, 200)], []);
    const result = move(document, ['one', 'two'], 0, 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(where(result.value.document, 'one')).toEqual({ track: 'v2', start: 0 });
    expect(where(result.value.document, 'two')).toEqual({ track: 'v2', start: 100 });
  });
});
