import { describe, expect, it } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type Track,
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
import {
  addTrack,
  clipsOnTrack,
  createTrack,
  firstTrackOfKind,
  nextTrackId,
  nextTrackName,
  removeTrack,
  renameTrack,
  setTrackHeight,
  toggleTrackFlag,
  TRACK_HEIGHT_RANGE,
} from './track-ops.js';

/**
 * Adding and removing tracks.
 *
 * The spec's timeline is N video, N audio, N text, and until this existed a project had exactly one
 * of each for its whole life. What is worth pinning down is *where* a new track lands and *what a
 * removal costs*, since both are decisions a user cannot undo by reading the screen.
 */

function documentOf(): TimelineDocument {
  return createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
}

function kinds(document: TimelineDocument): readonly string[] {
  return document.sequence.tracks.map((track) => track.kind);
}

function names(document: TimelineDocument): readonly string[] {
  return document.sequence.tracks.map((track) => track.name);
}

/** Adds a track, failing the test rather than the type checker if it was refused. */
function added(document: TimelineDocument, kind: Track['kind'], id: string): TimelineDocument {
  const result = addTrack(document, { kind, id: trackId(id) });
  if (!result.ok) throw new Error(`refused: ${result.error.kind}`);
  return result.value.document;
}

function clipOn(id: string): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

describe('where a new track lands', () => {
  it('goes after the last track of its own kind, not at the end', () => {
    // The timeline reads video, then audio, then text. A second video track appearing below the
    // audio would break that reading for every project it happened in.
    const document = added(documentOf(), 'video', 'v2');
    expect(kinds(document)).toEqual(['video', 'video', 'audio', 'text']);
  });

  it('puts a second audio track under the first', () => {
    const document = added(documentOf(), 'audio', 'a2');
    expect(kinds(document)).toEqual(['video', 'audio', 'audio', 'text']);
  });

  it('puts a second text track under the first', () => {
    const document = added(documentOf(), 'text', 't2');
    expect(kinds(document)).toEqual(['video', 'audio', 'text', 'text']);
  });

  it('puts the first video track above everything when there is none', () => {
    const empty = removeTrack(documentOf(), trackId('v1'));
    if (!empty.ok) throw new Error('unreachable');

    const document = added(empty.value, 'video', 'v9');
    expect(kinds(document)).toEqual(['video', 'audio', 'text']);
  });

  it('puts a first audio track below the picture, not above it', () => {
    const empty = removeTrack(documentOf(), trackId('a1'));
    if (!empty.ok) throw new Error('unreachable');

    const document = added(empty.value, 'audio', 'a9');
    expect(kinds(document)).toEqual(['video', 'text', 'audio']);
  });
});

describe('naming', () => {
  it('numbers a new track by its kind', () => {
    expect(names(added(documentOf(), 'video', 'v2'))).toEqual(['V1', 'V2', 'A1', 'T1']);
  });

  it('fills the gap a removal left rather than counting past it', () => {
    // After removing V2 from V1..V3, counting the survivors would produce V3 — a name already on
    // screen. Counting past the highest would produce V4 and leave a hole the user reads as a bug.
    let document = added(added(documentOf(), 'video', 'v2'), 'video', 'v3');
    const trimmed = removeTrack(document, trackId('v2'));
    if (!trimmed.ok) throw new Error('unreachable');
    document = added(trimmed.value, 'video', 'v4');

    expect(names(document).filter((name) => name.startsWith('V'))).toEqual(['V1', 'V3', 'V2']);
  });

  it('takes a name the caller insists on', () => {
    const result = addTrack(documentOf(), { kind: 'audio', id: trackId('a2'), name: 'A2 · music' });
    expect(result.ok && result.value.track.name).toBe('A2 · music');
  });

  it('suggests an id nothing is using', () => {
    const document = added(documentOf(), 'video', 'v2');
    expect(nextTrackId(document, 'video')).toBe('v3');
  });

  it('does not suggest an id that differs from an existing one only in case', () => {
    // `V1` and `v1` are indistinguishable in every log line and error message a user reads, and one
    // careless comparison away from being the same track.
    const base = createDocument({
      id: projectId('p'),
      sequenceId: sequenceId('s'),
      name: 'p',
      frameRate: FRAME_RATES.WEB_30,
      resolution: { width: 1920, height: 1080 },
      trackIds: { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') },
    });

    expect(nextTrackId(base, 'video')).toBe('v2');
  });
});

describe('refusing an add', () => {
  it('refuses a duplicate id, which would replace a track and everything on it', () => {
    const result = addTrack(documentOf(), { kind: 'video', id: trackId('v1') });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('duplicate-track');
  });
});

describe('removing', () => {
  it('takes the track´s clips with it, since undo is the safety net', () => {
    const base = documentOf();
    const withClips: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.id === 'v1' ? ({ ...track, clips: [clipOn('c1')] } as VideoTrack) : track,
        ),
      },
    };

    const result = removeTrack(withClips, trackId('v1'));
    expect(result.ok).toBe(true);
    expect(result.ok && kinds(result.value)).toEqual(['audio', 'text']);
  });

  it('says how much a removal would cost, before it happens', () => {
    const base = documentOf();
    const withClips: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.id === 'v1' ? ({ ...track, clips: [clipOn('c1'), clipOn('c2')] } as VideoTrack) : track,
        ),
      },
    };

    expect(clipsOnTrack(withClips, trackId('v1'))).toBe(2);
    expect(clipsOnTrack(withClips, trackId('a1'))).toBe(0);
  });

  it('refuses a locked track, or the lock would be worth nothing', () => {
    // Locking says "do not disturb this". Honouring it for a stray drag but not for a removal would
    // make it the weakest possible guarantee.
    const base = documentOf();
    const locked: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.id === 'v1' ? ({ ...track, locked: true } as Track) : track,
        ),
      },
    };

    const result = removeTrack(locked, trackId('v1'));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('track-locked');
  });

  it('names a track that is not there rather than doing nothing quietly', () => {
    const result = removeTrack(documentOf(), trackId('nope'));
    expect(result.ok ? '' : result.error.kind).toBe('track-not-found');
  });

  it('leaves the document alone on a refusal', () => {
    const document = documentOf();
    const result = removeTrack(document, trackId('nope'));
    expect(result.ok).toBe(false);
    expect(document.sequence.tracks).toHaveLength(3);
  });
});

describe('renaming', () => {
  it('takes a new name', () => {
    const result = renameTrack(documentOf(), trackId('a1'), 'A1 · music');
    expect(result.ok && result.value.sequence.tracks[1]?.name).toBe('A1 · music');
  });

  it('refuses a blank name, which nothing could be referred to by', () => {
    const result = renameTrack(documentOf(), trackId('a1'), '   ');
    expect(result.ok ? '' : result.error.kind).toBe('empty-name');
  });

  it('trims, so a stray space does not become part of the name', () => {
    const result = renameTrack(documentOf(), trackId('a1'), '  A1 · music  ');
    expect(result.ok && result.value.sequence.tracks[1]?.name).toBe('A1 · music');
  });

  it('renames a locked track, because the label is not on the track', () => {
    // Locking protects what is *on* a track. Refusing a rename would make locking a finished layer
    // cost the ability to say what it holds.
    const base = documentOf();
    const locked: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.id === 'v1' ? ({ ...track, locked: true } as Track) : track,
        ),
      },
    };

    expect(renameTrack(locked, trackId('v1'), 'V1 · locked').ok).toBe(true);
  });

  it('is a no-op when the name has not changed', () => {
    const document = documentOf();
    const result = renameTrack(document, trackId('v1'), 'V1');
    expect(result.ok && result.value).toBe(document);
  });
});

describe('track height', () => {
  it('resizes a track', () => {
    const result = setTrackHeight(documentOf(), trackId('v1'), 120);
    expect(result.ok && result.value.sequence.tracks[0]?.height).toBe(120);
  });

  it('keeps a row tall enough to hold its own controls', () => {
    const result = setTrackHeight(documentOf(), trackId('v1'), 2);
    expect(result.ok && result.value.sequence.tracks[0]?.height).toBe(TRACK_HEIGHT_RANGE.min);
  });

  it('stops one track from filling the window and hiding every other', () => {
    // The failure a free-form drag produces within about two seconds of being discovered.
    const result = setTrackHeight(documentOf(), trackId('v1'), 5000);
    expect(result.ok && result.value.sequence.tracks[0]?.height).toBe(TRACK_HEIGHT_RANGE.max);
  });

  it('rounds, because a row cannot be half a pixel tall', () => {
    const result = setTrackHeight(documentOf(), trackId('v1'), 100.6);
    expect(result.ok && result.value.sequence.tracks[0]?.height).toBe(101);
  });

  it('resizes a locked track, since its height is not on it', () => {
    const base = documentOf();
    const locked: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.id === 'v1' ? ({ ...track, locked: true } as Track) : track,
        ),
      },
    };

    expect(setTrackHeight(locked, trackId('v1'), 120).ok).toBe(true);
  });

  it('is a no-op at the height it already has', () => {
    const document = documentOf();
    const height = document.sequence.tracks[0]!.height;
    const result = setTrackHeight(document, trackId('v1'), height);

    expect(result.ok && result.value).toBe(document);
  });

  it('names a track that is not there', () => {
    expect(setTrackHeight(documentOf(), trackId('nope'), 100).ok).toBe(false);
  });
});

describe('the header flags', () => {
  it('mutes and unmutes', () => {
    const muted = toggleTrackFlag(documentOf(), trackId('a1'), 'muted');
    expect(muted.ok && muted.value.sequence.tracks[1]?.muted).toBe(true);

    const back = muted.ok ? toggleTrackFlag(muted.value, trackId('a1'), 'muted') : undefined;
    expect(back?.ok && back.value.sequence.tracks[1]?.muted).toBe(false);
  });

  it('lets a locked track still be muted and soloed', () => {
    // Locking protects a track's content, which is what every editing operation honours. Refusing to
    // mute one would mean locking a finished layer costs the ability to hear the mix without it.
    const base = documentOf();
    const locked: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.id === 'a1' ? ({ ...track, locked: true } as Track) : track,
        ),
      },
    };

    const result = toggleTrackFlag(locked, trackId('a1'), 'muted');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.sequence.tracks[1]?.muted).toBe(true);
    expect(result.ok && result.value.sequence.tracks[1]?.locked).toBe(true);
  });

  it('touches only the track it names', () => {
    const result = toggleTrackFlag(documentOf(), trackId('v1'), 'solo');
    expect(result.ok && result.value.sequence.tracks.map((track) => track.solo)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('names a track that is not there', () => {
    const result = toggleTrackFlag(documentOf(), trackId('nope'), 'muted');
    expect(result.ok ? '' : result.error.kind).toBe('track-not-found');
  });
});

describe('finding where material lands', () => {
  it('resolves the first track of a kind rather than assuming an id', () => {
    // Fixed ids were safe only while the track list could not change. Now that it can, an import
    // targeting a hard-coded `v1` would fail on a project whose first video track was remade.
    const trimmed = removeTrack(documentOf(), trackId('v1'));
    if (!trimmed.ok) throw new Error('unreachable');
    const document = added(trimmed.value, 'video', 'v7');

    expect(firstTrackOfKind(document, 'video')?.id).toBe('v7');
  });

  it('answers nothing when a kind has no track at all', () => {
    const trimmed = removeTrack(documentOf(), trackId('t1'));
    expect(trimmed.ok && firstTrackOfKind(trimmed.value, 'text')).toBeUndefined();
  });
});

describe('the track a constructor makes', () => {
  it('gives a new audio track unity gain and centre pan', () => {
    // A default the user did not choose is a bug they will chase in the mixer, not here.
    const track = createTrack('audio', { id: trackId('a2'), name: 'A2' });
    expect(track.kind === 'audio' && track.gain).toBe(1);
    expect(track.kind === 'audio' && track.pan).toBe(0);
  });

  it('gives a video track somewhere to put transitions', () => {
    const track = createTrack('video', { id: trackId('v2'), name: 'V2' });
    expect(track.kind === 'video' && track.transitions).toEqual([]);
  });

  it('starts unlocked, unmuted and empty whatever the kind', () => {
    for (const kind of ['video', 'audio', 'text'] as const) {
      const track = createTrack(kind, { id: trackId(`x-${kind}`), name: 'X' });
      expect(track.locked).toBe(false);
      expect(track.muted).toBe(false);
      expect(track.clips).toEqual([]);
    }
  });

  it('is as tall as its kind is drawn', () => {
    expect(createTrack('video', { id: trackId('v'), name: 'V' }).height).toBeGreaterThan(
      createTrack('text', { id: trackId('t'), name: 'T' }).height,
    );
  });
});

describe('naming a kind with none of its own', () => {
  it('starts at one', () => {
    const trimmed = removeTrack(documentOf(), trackId('t1'));
    expect(trimmed.ok && nextTrackName(trimmed.value, 'text')).toBe('T1');
  });
});
