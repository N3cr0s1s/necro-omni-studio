import { describe, expect, it } from 'vitest';
import {
  type TimelineDocument,
  type Track,
  type VideoClip,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  effectId,
  effectInstanceId,
  endExclusive,
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { addTransition, describeTransitionError, removeTransition, transitionsOf } from './transition-ops.js';

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

function videoClip(id: string, start: number, end: number, sourceIn = 100): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(sourceIn),
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

const request = {
  from: clipId('a'),
  to: clipId('b'),
  effect: effectId('crossfade'),
  durationFrames: 12,
  id: effectInstanceId('t1'),
};

/** Two clips meeting at frame 100, each with a hundred frames of handle on either side. */
const adjacent = () => documentWith([videoClip('a', 0, 100), videoClip('b', 100, 200)]);

const videoTrack = (document: TimelineDocument) =>
  document.sequence.tracks.find((track) => track.id === TRACKS.video)!;

describe('adding a transition', () => {
  it('records the overlap it created', () => {
    const result = addTransition(adjacent(), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const track = videoTrack(result.value);
    expect(track.kind === 'video' && track.transitions).toHaveLength(1);
    if (track.kind !== 'video') return;
    // Centred on the cut: six frames either side of frame 100.
    expect(track.transitions[0]?.span).toEqual(spanFromBounds(frameIndex(94), frameIndex(106)));
  });

  it('extends the outgoing clip past the cut', () => {
    const result = addTransition(adjacent(), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const track = videoTrack(result.value);
    const from = track.clips.find((clip) => clip.id === 'a');
    expect(from !== undefined && endExclusive(from.span)).toBe(106);
  });

  it('pulls the incoming clip back, taking its source point with it', () => {
    // The in-point must move by the same amount, or the transition would dissolve into a frame the
    // clip never showed.
    const result = addTransition(adjacent(), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const to = videoTrack(result.value).clips.find((clip) => clip.id === 'b');
    expect(to?.span.start).toBe(94);
    expect(to?.kind === 'video' && to.source.sourceIn).toBe(94);
  });

  it('does not change the sequence length', () => {
    // The overlap comes from handles, not from moving anything: an edit that shortened the piece
    // because a dissolve was added would be a surprise every time.
    const before = adjacent();
    const result = addTransition(before, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const end = (document: TimelineDocument) =>
      Math.max(...videoTrack(document).clips.map((clip) => endExclusive(clip.span)));
    expect(end(result.value)).toBe(end(before));
  });

  it('carries the effect and the clips it joins', () => {
    const result = addTransition(adjacent(), request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const track = videoTrack(result.value);
    if (track.kind !== 'video') return;
    expect(track.transitions[0]).toMatchObject({ effect: 'crossfade', from: 'a', to: 'b' });
  });

  it('splits an odd duration with the extra frame after the cut', () => {
    // Arbitrary but fixed: an unstated rule here would make a 13-frame transition land differently
    // depending on which clip was selected first.
    const result = addTransition(adjacent(), { ...request, durationFrames: 13 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const track = videoTrack(result.value);
    if (track.kind !== 'video') return;
    expect(track.transitions[0]?.span).toEqual(spanFromBounds(frameIndex(94), frameIndex(107)));
  });
});

describe('rejections', () => {
  it('refuses clips that do not meet at a cut', () => {
    const gapped = documentWith([videoClip('a', 0, 100), videoClip('b', 120, 200)]);
    const result = addTransition(gapped, request);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-adjacent');
  });

  it('refuses a transition longer than the material it joins', () => {
    // A dissolve between two things the viewer never fully sees is not a transition.
    const short = documentWith([videoClip('a', 0, 10), videoClip('b', 10, 20)]);
    const result = addTransition(short, { ...request, durationFrames: 40 });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'too-long') {
      expect(result.error.maximum).toBe(19);
    } else {
      throw new Error('expected a length rejection');
    }
  });

  it('refuses a one-frame transition, which is a cut with machinery', () => {
    const result = addTransition(adjacent(), { ...request, durationFrames: 1 });
    expect(result.ok).toBe(false);
  });

  it('refuses when the incoming clip has no handle before its in-point', () => {
    // Starting at source frame 0 means there is nothing earlier to dissolve from, and the honest
    // answer is a reason rather than a transition that holds a frozen frame.
    const noHandle = documentWith([videoClip('a', 0, 100), videoClip('b', 100, 200, 0)]);
    const result = addTransition(noHandle, request);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'no-handles') {
      expect(result.error.clip).toBe('b');
      expect(result.error.needed).toBe(6);
    } else {
      throw new Error('expected a handle rejection');
    }
  });

  it('refuses when the outgoing clip has no material past its out-point', () => {
    const result = addTransition(adjacent(), request, {
      // The source ends exactly where the clip does.
      sources: { boundsFor: () => ({ totalFrames: 200 }) },
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'no-handles') {
      expect(result.error.clip).toBe('a');
    } else {
      throw new Error('expected a handle rejection');
    }
  });

  it('proceeds when the source length is unknown', () => {
    // The same rule every other operation follows: better to allow an edit a later probe corrects
    // than to block editing because metadata has not arrived.
    expect(addTransition(adjacent(), request, { sources: { boundsFor: () => undefined } }).ok).toBe(true);
  });

  it('refuses a locked track', () => {
    const base = adjacent();
    const locked: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.id === TRACKS.video ? { ...track, locked: true } : track,
        ),
      },
    };
    const result = addTransition(locked, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('track-locked');
  });

  it('names a clip that is not there', () => {
    const result = addTransition(adjacent(), { ...request, to: clipId('missing') });
    expect(result.ok).toBe(false);
  });
});

describe('replacing an existing transition', () => {
  it('does not leave two transitions on one cut', () => {
    // The plan takes the first transition containing the frame; two would make the result depend on
    // insertion order.
    const once = addTransition(adjacent(), request);
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    const twice = addTransition(once.value, {
      ...request,
      id: effectInstanceId('t2'),
      effect: effectId('wipe'),
    });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;

    const track = videoTrack(twice.value);
    if (track.kind !== 'video') return;
    expect(track.transitions).toHaveLength(1);
    expect(track.transitions[0]?.effect).toBe('wipe');
  });
});

describe('removing a transition', () => {
  it('returns both clips to the cut', () => {
    const added = addTransition(adjacent(), request);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const removed = removeTransition(added.value, effectInstanceId('t1'));
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;

    const track = videoTrack(removed.value);
    const from = track.clips.find((clip) => clip.id === 'a');
    const to = track.clips.find((clip) => clip.id === 'b');

    expect(from !== undefined && endExclusive(from.span)).toBe(100);
    expect(to?.span.start).toBe(100);
  });

  it('returns the source point it borrowed', () => {
    const added = addTransition(adjacent(), request);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const removed = removeTransition(added.value, effectInstanceId('t1'));
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;

    const to = videoTrack(removed.value).clips.find((clip) => clip.id === 'b');
    expect(to?.kind === 'video' && to.source.sourceIn).toBe(100);
  });

  it('round trips exactly', () => {
    // The strongest statement available: adding and removing leaves the document it started from.
    const before = adjacent();
    const added = addTransition(before, request);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const removed = removeTransition(added.value, effectInstanceId('t1'));
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value).toEqual(before);
  });

  it('drops a record whose clips are gone rather than leaving it dangling', () => {
    const added = addTransition(adjacent(), request);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const withoutClips: TimelineDocument = {
      ...added.value,
      sequence: {
        ...added.value.sequence,
        tracks: added.value.sequence.tracks.map((track) =>
          track.id === TRACKS.video ? ({ ...track, clips: [] } as Track) : track,
        ),
      },
    };

    const removed = removeTransition(withoutClips, effectInstanceId('t1'));
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const track = videoTrack(removed.value);
    expect(track.kind === 'video' && track.transitions).toHaveLength(0);
  });

  it('reports an id it does not have', () => {
    expect(removeTransition(adjacent(), effectInstanceId('nope')).ok).toBe(false);
  });
});

describe('lookup and wording', () => {
  it('finds the transitions touching a clip', () => {
    const added = addTransition(adjacent(), request);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    expect(transitionsOf(added.value, clipId('a'))).toHaveLength(1);
    expect(transitionsOf(added.value, clipId('b'))).toHaveLength(1);
    expect(transitionsOf(added.value, clipId('nope'))).toHaveLength(0);
  });

  it('explains a rejection in terms a user can act on', () => {
    expect(describeTransitionError({ kind: 'not-adjacent', from: clipId('a'), to: clipId('b') })).toContain(
      'meet at a cut',
    );
    expect(describeTransitionError({ kind: 'no-handles', clip: clipId('b'), needed: 6 })).toContain('6 more');
    expect(describeTransitionError({ kind: 'too-long', maximum: 19 })).toContain('19');
  });
});
