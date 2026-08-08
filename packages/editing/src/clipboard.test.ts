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
  effectId,
  effectInstanceId,
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { EMPTY_CLIPBOARD, copyClips, firstFreePaste, pasteClips } from './clipboard.js';
import { removeTrack } from './track-ops.js';

/**
 * Copying and pasting.
 *
 * The design turns on what a copied clip remembers: not its absolute position, which is the one thing
 * the user is about to change, but its offset from the earliest clip in the copy. That is what makes
 * a multi-clip paste preserve the shape of what was copied.
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

function documentWith(clips: readonly Clip[]): TimelineDocument {
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
        const mine = clips.filter((clip) => track.kind === kindOf(clip));
        return mine.length === 0 ? track : ({ ...track, clips: mine } as Track);
      }),
    },
  };
}

function kindOf(clip: Clip): string {
  return clip.kind === 'image' ? 'video' : clip.kind;
}

/** Every clip on the timeline as `id@start..end`, in timeline order. */
function placed(document: TimelineDocument): readonly string[] {
  return document.sequence.tracks
    .flatMap((track) => track.clips.map((clip) => clip))
    .map((clip) => `${clip.id}@${clip.span.start}..${clip.span.start + clip.span.duration}`)
    .sort();
}

const ids = (...names: string[]) => names.map((name) => clipId(name));

describe('what a copy remembers', () => {
  it('keeps offsets rather than positions', () => {
    const document = documentWith([video('a', 100, 200), video('b', 300, 350)]);
    const clipboard = copyClips(document, ids('a', 'b'));

    expect(clipboard.entries.map((entry) => entry.offset)).toEqual([0, 200]);
    expect(clipboard.durationFrames).toBe(250);
  });

  it('carries everything on the clip, not a summary of it', () => {
    // Effects, keyframes and provenance are the reason a user copies a clip rather than remaking it.
    const document = documentWith([
      video('a', 0, 100, {
        effects: [{ id: effectInstanceId('fx1'), effect: effectId('levels'), enabled: true, params: {} }],
      }),
    ]);

    const clipboard = copyClips(document, ids('a'));
    expect(clipboard.entries[0]?.clip.effects).toHaveLength(1);
  });

  it('survives the original being deleted, which is what a cut is', () => {
    const document = documentWith([video('a', 0, 100)]);
    const clipboard = copyClips(document, ids('a'));
    const emptied = documentWith([]);

    const result = pasteClips(emptied, clipboard, { at: frameIndex(0), ids: ids('copy') });
    expect(result.ok && placed(result.value.document)).toEqual(['copy@0..100']);
  });

  it('ignores an id nothing answers to', () => {
    const document = documentWith([video('a', 0, 100)]);
    expect(copyClips(document, ids('a', 'ghost')).entries).toHaveLength(1);
  });

  it('is empty for an empty selection rather than undefined', () => {
    expect(copyClips(documentWith([]), []).entries).toEqual([]);
  });
});

describe('pasting', () => {
  it('lands the earliest clip at the frame asked for', () => {
    const document = documentWith([video('a', 100, 200)]);
    const clipboard = copyClips(document, ids('a'));

    const result = pasteClips(document, clipboard, { at: frameIndex(500), ids: ids('copy') });
    expect(result.ok && placed(result.value.document)).toContain('copy@500..600');
  });

  it('preserves the shape of a multi-clip copy', () => {
    // A title and its music cue land the same distance apart wherever they are put down.
    const document = documentWith([video('a', 100, 200), audio('m', 150, 400)]);
    const clipboard = copyClips(document, ids('a', 'm'));

    const result = pasteClips(document, clipboard, { at: frameIndex(1000), ids: ids('a2', 'm2') });
    expect(result.ok && placed(result.value.document)).toEqual([
      'a2@1000..1100',
      'a@100..200',
      'm2@1050..1300',
      'm@150..400',
    ]);
  });

  it('puts each clip back on the kind of track it came from', () => {
    const document = documentWith([video('a', 0, 100), audio('m', 0, 100)]);
    const clipboard = copyClips(document, ids('a', 'm'));

    const result = pasteClips(document, clipboard, { at: frameIndex(500), ids: ids('a2', 'm2') });
    if (!result.ok) throw new Error('refused');

    const tracks = result.value.document.sequence.tracks;
    expect(tracks[0]?.clips.some((clip) => clip.id === 'a2')).toBe(true);
    expect(tracks[1]?.clips.some((clip) => clip.id === 'm2')).toBe(true);
  });

  it('falls back to the first track of the kind when the original is gone', () => {
    // A copy made before a track was tidied away is still worth pasting.
    const document = documentWith([video('a', 0, 100)]);
    const clipboard = copyClips(document, ids('a'));
    const trimmed = removeTrack(document, trackId('v1'));
    if (!trimmed.ok) throw new Error('unreachable');

    const result = pasteClips(trimmed.value, clipboard, { at: frameIndex(0), ids: ids('copy') });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('track-not-found');
  });

  it('never lands before the start of the sequence', () => {
    const document = documentWith([video('a', 100, 200)]);
    const clipboard = copyClips(document, ids('a'));

    const result = pasteClips(documentWith([]), clipboard, { at: frameIndex(0), ids: ids('copy') });
    expect(result.ok && placed(result.value.document)).toEqual(['copy@0..100']);
  });
});

describe('refusing a paste', () => {
  it('refuses a collision rather than displacing anything', () => {
    const document = documentWith([video('a', 0, 100)]);
    const clipboard = copyClips(document, ids('a'));

    const result = pasteClips(document, clipboard, { at: frameIndex(50), ids: ids('copy') });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('collision');
  });

  it('is all or nothing, so a lower third is never half pasted', () => {
    // The user cannot see which half is missing without inspecting a clipboard they cannot inspect.
    const document = documentWith([video('a', 0, 100), audio('m', 0, 100), audio('blocker', 500, 600)]);
    const clipboard = copyClips(document, ids('a', 'm'));

    const before = placed(document);
    const result = pasteClips(document, clipboard, { at: frameIndex(500), ids: ids('a2', 'm2') });

    expect(result.ok).toBe(false);
    expect(placed(document)).toEqual(before);
  });

  it('catches two clips of one paste landing on each other', () => {
    // They would each pass a check made against the document alone.
    const document = documentWith([video('a', 0, 100), video('b', 100, 200)]);
    const clipboard = copyClips(document, ids('a', 'b'));
    const emptied = documentWith([]);

    // Rewriting the second entry's offset to overlap the first is the degenerate case.
    const overlapping = {
      ...clipboard,
      entries: clipboard.entries.map((entry, index) => (index === 1 ? { ...entry, offset: 50 } : entry)),
    };

    const result = pasteClips(emptied, overlapping, { at: frameIndex(0), ids: ids('a2', 'b2') });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('collision');
  });

  it('refuses a locked destination', () => {
    const document = documentWith([video('a', 0, 100)]);
    const clipboard = copyClips(document, ids('a'));
    const locked: TimelineDocument = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.id === 'v1' ? ({ ...track, locked: true } as Track) : track,
        ),
      },
    };

    const result = pasteClips(locked, clipboard, { at: frameIndex(500), ids: ids('copy') });
    expect(result.ok ? '' : result.error.kind).toBe('track-locked');
  });

  it('does nothing at all for an empty clipboard', () => {
    const document = documentWith([video('a', 0, 100)]);
    const result = pasteClips(document, EMPTY_CLIPBOARD, { at: frameIndex(0), ids: [] });

    expect(result.ok && result.value.document).toBe(document);
    expect(result.ok && result.value.clips).toEqual([]);
  });
});

describe('finding somewhere it fits', () => {
  it('returns the asked-for frame when nothing is in the way', () => {
    const document = documentWith([video('a', 0, 100)]);
    const clipboard = copyClips(document, ids('a'));

    expect(firstFreePaste(document, clipboard, frameIndex(500))).toBe(500);
  });

  it('lands just past what is in the way', () => {
    const document = documentWith([video('a', 0, 100), video('b', 200, 400)]);
    const clipboard = copyClips(document, ids('a'));

    expect(firstFreePaste(document, clipboard, frameIndex(150))).toBe(400);
  });

  it('searches forward only, because pasting earlier would be a surprise', () => {
    const document = documentWith([video('a', 0, 100)]);
    const clipboard = copyClips(document, ids('a'));

    expect(firstFreePaste(document, clipboard, frameIndex(1000))).toBe(1000);
  });

  it('finds room for a multi-track copy where every track is free', () => {
    const document = documentWith([video('a', 0, 100), audio('m', 0, 100), audio('later', 150, 300)]);
    const clipboard = copyClips(document, ids('a', 'm'));

    const at = firstFreePaste(document, clipboard, frameIndex(0));
    const result = pasteClips(document, clipboard, { at, ids: ids('a2', 'm2') });
    expect(result.ok).toBe(true);
  });

  it('terminates on an empty clipboard rather than searching for nothing', () => {
    expect(firstFreePaste(documentWith([]), EMPTY_CLIPBOARD, frameIndex(42))).toBe(42);
  });
});
