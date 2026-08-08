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
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { copyAttributes, describeAttributes, pasteAttributes } from './attributes.js';

/**
 * Copying a clip's look onto others.
 *
 * The boundary is the whole design: everything that describes *how a clip looks or sounds* travels,
 * and nothing that describes **which material it is or where it sits**. A paste that moved a clip or
 * swapped its media would be indistinguishable from a bug, so most of these tests are about what must
 * not change.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(start + 100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(`media/${id}.mp4`), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

function audio(id: string, start: number, extra: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(start + 100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.flac'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...extra,
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

const graded = (id: string, start: number) =>
  video(id, start, {
    effects: [
      { id: effectInstanceId(`${id}_fx1`), effect: effectId('levels'), enabled: true, params: {} },
      { id: effectInstanceId(`${id}_fx2`), effect: effectId('film_grain'), enabled: true, params: {} },
    ],
    transform: { ...transform, scale: staticNumber(1.2) },
  });

const newIds = (target: string, index: number) => effectInstanceId(`${target}_pasted${index}`);

describe('what travels', () => {
  it('takes the effect stack', () => {
    const document = documentWith([graded('a', 0), video('b', 200)]);
    const attributes = copyAttributes(document, clipId('a'))!;
    const result = pasteAttributes(document, {
      targets: [clipId('b')],
      attributes,
      effectId: newIds,
    });

    const pasted = result.ok ? locateClip(result.value.document, clipId('b'))?.clip : undefined;
    expect(pasted?.effects.map((instance) => instance.effect)).toEqual(['levels', 'film_grain']);
  });

  it('gives every pasted effect a fresh id', () => {
    // Two clips sharing an instance id would make every later edit land on whichever clip was found
    // first, and the inspector's selection ambiguous.
    const document = documentWith([graded('a', 0), video('b', 200)]);
    const result = pasteAttributes(document, {
      targets: [clipId('b')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
    });

    const pasted = result.ok ? locateClip(result.value.document, clipId('b'))?.clip : undefined;
    expect(pasted?.effects.map((instance) => instance.id)).toEqual(['b_pasted0', 'b_pasted1']);
  });

  it('takes the transform', () => {
    const document = documentWith([graded('a', 0), video('b', 200)]);
    const result = pasteAttributes(document, {
      targets: [clipId('b')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
    });

    const pasted = result.ok ? locateClip(result.value.document, clipId('b'))?.clip : undefined;
    const scale = pasted?.kind === 'video' ? pasted.transform.scale : undefined;
    expect(scale?.kind === 'static' && scale.value).toBe(1.2);
  });

  it('takes level and pan between audio clips', () => {
    const document = documentWith([], [audio('m', 0, { gain: staticNumber(0.5) }), audio('n', 200)]);
    const result = pasteAttributes(document, {
      targets: [clipId('n')],
      attributes: copyAttributes(document, clipId('m'))!,
      effectId: newIds,
    });

    const pasted = result.ok ? locateClip(result.value.document, clipId('n'))?.clip : undefined;
    const gain = pasted?.kind === 'audio' ? pasted.gain : undefined;
    expect(gain?.kind === 'static' && gain.value).toBe(0.5);
  });
});

describe('what must not travel', () => {
  it('leaves the target where it is', () => {
    const document = documentWith([graded('a', 0), video('b', 200)]);
    const result = pasteAttributes(document, {
      targets: [clipId('b')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
    });

    expect(result.ok && locateClip(result.value.document, clipId('b'))?.clip.span.start).toBe(200);
  });

  it('leaves the target´s media alone', () => {
    // A paste that swapped the media would be indistinguishable from a bug.
    const document = documentWith([graded('a', 0), video('b', 200)]);
    const result = pasteAttributes(document, {
      targets: [clipId('b')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
    });

    const pasted = result.ok ? locateClip(result.value.document, clipId('b'))?.clip : undefined;
    expect(pasted?.kind === 'video' && pasted.source.asset).toBe('media/b.mp4');
  });

  it('leaves the target´s name alone', () => {
    const document = documentWith([graded('a', 0), video('b', 200)]);
    const result = pasteAttributes(document, {
      targets: [clipId('b')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
    });

    expect(result.ok && locateClip(result.value.document, clipId('b'))?.clip.label).toBe('b');
  });
});

describe('across kinds', () => {
  it('drops a transform onto audio rather than refusing the paste', () => {
    // A user who selected a scene and pasted a look meant it to land wherever it makes sense, not to
    // be told that one of the eleven clips was audio.
    const document = documentWith([graded('a', 0)], [audio('m', 0)]);
    const result = pasteAttributes(document, {
      targets: [clipId('m')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
    });

    expect(result.ok).toBe(true);
    const pasted = result.ok ? locateClip(result.value.document, clipId('m'))?.clip : undefined;
    expect(pasted?.kind).toBe('audio');
    expect(pasted?.effects).toHaveLength(2);
  });

  it('applies to every target at once', () => {
    const document = documentWith([graded('a', 0), video('b', 200), video('c', 400)]);
    const result = pasteAttributes(document, {
      targets: [clipId('b'), clipId('c')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
    });

    expect(result.ok && result.value.applied).toEqual(['b', 'c']);
  });
});

describe('parts', () => {
  it('can move a grade without moving the framing', () => {
    const document = documentWith([graded('a', 0), video('b', 200)]);
    const result = pasteAttributes(document, {
      targets: [clipId('b')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
      parts: { effects: true, transform: false },
    });

    const pasted = result.ok ? locateClip(result.value.document, clipId('b'))?.clip : undefined;
    const scale = pasted?.kind === 'video' ? pasted.transform.scale : undefined;
    expect(pasted?.effects).toHaveLength(2);
    expect(scale?.kind === 'static' && scale.value).toBe(1);
  });
});

describe('locked targets', () => {
  const withLockedVideo = () => {
    const base = documentWith([graded('a', 0), video('b', 200)], [audio('m', 0)]);
    return {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.kind === 'video' ? ({ ...track, locked: true } as Track) : track,
        ),
      },
    };
  };

  it('refuses when nothing at all could take it', () => {
    const document = withLockedVideo();
    const attributes = copyAttributes(document, clipId('a'))!;
    const result = pasteAttributes(document, {
      targets: [clipId('b')],
      attributes,
      effectId: newIds,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('track-locked');
  });

  it('lets the unprotected targets take it, so one locked clip cannot block ten', () => {
    const document = withLockedVideo();
    const attributes = copyAttributes(document, clipId('a'))!;
    const result = pasteAttributes(document, {
      targets: [clipId('b'), clipId('m')],
      attributes,
      effectId: newIds,
    });

    expect(result.ok && result.value.applied).toEqual(['m']);
  });
});

describe('describing what would be pasted', () => {
  it('names the parts rather than counting them', () => {
    // "3 effects, transform" tells a user whether this is what they copied; "4 attributes" does not.
    const document = documentWith([graded('a', 0)]);
    expect(describeAttributes(copyAttributes(document, clipId('a'))!)).toBe('2 effects, transform');
  });

  it('says so when there is nothing to paste', () => {
    const document = documentWith([], [audio('m', 0)]);
    const attributes = { effects: [] };
    expect(describeAttributes(attributes)).toBe('nothing to paste');
    expect(describeAttributes(copyAttributes(document, clipId('m'))!)).toContain('level');
  });

  it('mentions speed only when it is not unity', () => {
    const document = documentWith([video('a', 0)]);
    expect(describeAttributes(copyAttributes(document, clipId('a'))!)).not.toContain('speed');
  });
});

describe('missing clips', () => {
  it('reports nothing to copy from a clip that is gone', () => {
    expect(copyAttributes(documentWith([]), clipId('ghost'))).toBeUndefined();
  });

  it('skips a target that is gone rather than failing the paste', () => {
    const document = documentWith([graded('a', 0), video('b', 200)]);
    const result = pasteAttributes(document, {
      targets: [clipId('ghost'), clipId('b')],
      attributes: copyAttributes(document, clipId('a'))!,
      effectId: newIds,
    });

    expect(result.ok && result.value.applied).toEqual(['b']);
  });
});
