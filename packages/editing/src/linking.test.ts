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
  linkedPartner,
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { linkClips, linkablePair, unlinkClips } from './linking.js';

/**
 * Linking a picture to its sound.
 *
 * The rule everything here protects: a link is **symmetric**. A one-sided one is worse than none,
 * because every operation that follows a link would then behave differently depending on which half
 * the user happened to grab.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

function audio(id: string, extra: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...extra,
  } as AudioClip;
}

function documentWith(clips: readonly Clip[], audioClips: readonly AudioClip[]): TimelineDocument {
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

const linked = () =>
  documentWith(
    [video('v', { linkedAudio: clipId('a') } as Partial<Clip>)],
    [audio('a', { linkedVideo: clipId('v') })],
  );

const partnerOf = (document: TimelineDocument, id: string) => {
  const located = locateClip(document, clipId(id));
  return located === undefined ? undefined : linkedPartner(located.clip);
};

describe('whether a selection can be linked', () => {
  // The other half of unlinking, which had no way back at all: `linkClips` existed and was tested and
  // had no caller, so splitting a pair was a one-way door and the only recovery was undo.
  it('is a video and an audio clip, in either selection order', () => {
    const document = documentWith([video('v')], [audio('a')]);
    expect(linkablePair(document, [clipId('v'), clipId('a')])).toEqual({ video: 'v', audio: 'a' });
    expect(linkablePair(document, [clipId('a'), clipId('v')])).toEqual({ video: 'v', audio: 'a' });
  });

  it('is nothing for one clip, or three', () => {
    const document = documentWith(
      [video('v'), video('v2', { span: spanFromBounds(frameIndex(100), frameIndex(200)) })],
      [audio('a')],
    );
    expect(linkablePair(document, [clipId('v')])).toBeUndefined();
    expect(linkablePair(document, [clipId('v'), clipId('v2'), clipId('a')])).toBeUndefined();
  });

  it('is nothing for two clips of the same kind', () => {
    const document = documentWith(
      [video('v'), video('v2', { span: spanFromBounds(frameIndex(100), frameIndex(200)) })],
      [],
    );
    expect(linkablePair(document, [clipId('v'), clipId('v2')])).toBeUndefined();
  });

  it('is nothing when either side already belongs to a pair', () => {
    // Stealing one would leave the other half pointing at nothing.
    const document = documentWith([video('v')], [audio('a')]);
    const linked = linkClips(document, clipId('v'), clipId('a'));
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linkablePair(linked.value, [clipId('v'), clipId('a')])).toBeUndefined();
  });

  it('is nothing when a clip in the selection no longer exists', () => {
    const document = documentWith([video('v')], [audio('a')]);
    expect(linkablePair(document, [clipId('v'), clipId('gone')])).toBeUndefined();
  });
});

describe('unlinking', () => {
  it('breaks both sides', () => {
    // A one-sided link would make an operation behave differently depending on which half was grabbed.
    const result = unlinkClips(linked(), clipId('v'));

    expect(result.ok && partnerOf(result.value, 'v')).toBeUndefined();
    expect(result.ok && partnerOf(result.value, 'a')).toBeUndefined();
  });

  it('works from either half', () => {
    const result = unlinkClips(linked(), clipId('a'));

    expect(result.ok && partnerOf(result.value, 'v')).toBeUndefined();
    expect(result.ok && partnerOf(result.value, 'a')).toBeUndefined();
  });

  it('leaves the clips themselves alone', () => {
    // Unlinking is not a cut: both clips stay exactly where and what they were.
    const result = unlinkClips(linked(), clipId('v'));
    const located = result.ok ? locateClip(result.value, clipId('v')) : undefined;

    expect(located?.clip.span.start).toBe(0);
    expect(located?.clip.label).toBe('v');
  });

  it('is a no-op on a clip that was never linked', () => {
    const document = documentWith([video('v')], []);
    const result = unlinkClips(document, clipId('v'));
    expect(result.ok && result.value).toBe(document);
  });

  it('survives a partner that is already gone', () => {
    // A half-broken document is still editable; refusing here would strand the survivor.
    const document = documentWith([video('v', { linkedAudio: clipId('ghost') } as Partial<Clip>)], []);
    const result = unlinkClips(document, clipId('v'));

    expect(result.ok && partnerOf(result.value, 'v')).toBeUndefined();
  });

  it('names a clip that is not there', () => {
    expect(unlinkClips(linked(), clipId('nope')).ok).toBe(false);
  });
});

describe('linking', () => {
  it('records the link on both sides', () => {
    const document = documentWith([video('v')], [audio('a')]);
    const result = linkClips(document, clipId('v'), clipId('a'));

    expect(result.ok && partnerOf(result.value, 'v')).toBe('a');
    expect(result.ok && partnerOf(result.value, 'a')).toBe('v');
  });

  it('refuses to steal a partner, which would leave a one-sided link', () => {
    const document = documentWith(
      [video('v', { linkedAudio: clipId('a') } as Partial<Clip>), video('w')],
      [audio('a', { linkedVideo: clipId('v') })],
    );

    const result = linkClips(document, clipId('w'), clipId('a'));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('already-linked');
  });

  it('accepts re-linking a pair that is already linked to each other', () => {
    const result = linkClips(linked(), clipId('v'), clipId('a'));
    expect(result.ok).toBe(true);
  });

  it('refuses a pair that is not one picture and one sound', () => {
    const document = documentWith([video('v'), video('w')], []);
    const result = linkClips(document, clipId('v'), clipId('w'));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('wrong-track-kind');
  });

  it('names a clip that is not there', () => {
    const document = documentWith([video('v')], []);
    expect(linkClips(document, clipId('v'), clipId('ghost')).ok).toBe(false);
  });
});

describe('round trip', () => {
  it('unlinks and links back to where it started', () => {
    const document = linked();
    const broken = unlinkClips(document, clipId('v'));
    const remade = broken.ok ? linkClips(broken.value, clipId('v'), clipId('a')) : undefined;

    expect(remade?.ok && partnerOf(remade.value, 'v')).toBe('a');
    expect(remade?.ok && partnerOf(remade.value, 'a')).toBe('v');
  });
});
