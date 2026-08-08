import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type TimelineDocument,
  type Track,
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
import {
  type ImportMediaRequest,
  DEFAULT_STILL_SECONDS,
  firstFreeFrame,
  importMedia,
} from './import-media.js';

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

function emptyProject(): TimelineDocument {
  return createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'P',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });
}

function withClips(
  document: TimelineDocument,
  kind: 'video' | 'audio',
  clips: readonly unknown[],
): TimelineDocument {
  return {
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((track) =>
        track.kind === kind ? ({ ...track, clips } as Track) : track,
      ),
    },
  };
}

function audioClip(id: string, start: number, end: number): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/x.wav'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
  };
}

function request(overrides: Partial<ImportMediaRequest> = {}): ImportMediaRequest {
  return {
    asset: assetPath('media/shot.mp4'),
    type: 'video',
    durationSeconds: 4,
    at: frameIndex(0),
    videoTrack: TRACKS.video,
    audioTrack: TRACKS.audio,
    label: 'shot.mp4',
    id: clipId('v1'),
    linkedId: clipId('v1_audio'),
    ...overrides,
  };
}

const clipsOn = (document: TimelineDocument, kind: 'video' | 'audio') =>
  document.sequence.tracks.find((track) => track.kind === kind)?.clips ?? [];

describe('a video with no audio stream', () => {
  const silent = () => importMedia(emptyProject(), request({ hasAudio: false }));

  it('lands one clip on the picture track', () => {
    const result = silent();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(clipsOn(result.value.document, 'video')).toHaveLength(1);
    expect(clipsOn(result.value.document, 'audio')).toHaveLength(0);
  });

  it('takes its length from the probe, at the project´s rate', () => {
    const result = silent();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clips[0]?.span.duration).toBe(120);
  });

  it('starts at the requested frame', () => {
    const result = importMedia(emptyProject(), request({ hasAudio: false, at: frameIndex(90) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clips[0]?.span.start).toBe(90);
  });

  it('keeps the file´s own rate for the retime, not the project´s', () => {
    // A 24 fps clip on a 30 fps timeline reads the wrong source frame if this is lost.
    const result = importMedia(emptyProject(), request({ hasAudio: false, sourceRate: FRAME_RATES.FILM_24 }));
    expect(result.ok).toBe(true);
    if (result.ok && result.value.clips[0]?.kind === 'video') {
      expect(result.value.clips[0].source.sourceRate).toEqual(FRAME_RATES.FILM_24);
    }
  });

  it('carries no link, since there is nothing to link to', () => {
    const result = silent();
    expect(result.ok).toBe(true);
    if (result.ok && result.value.clips[0]?.kind === 'video') {
      expect(result.value.clips[0].linkedAudio).toBeUndefined();
    }
  });
});

describe('a video carrying audio', () => {
  const paired = () => importMedia(emptyProject(), request({ hasAudio: true }));

  it('becomes a video clip with an audio clip beneath it', () => {
    // The spec's rule, and the whole reason this operation is not a one-liner.
    const result = paired();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(clipsOn(result.value.document, 'video')).toHaveLength(1);
    expect(clipsOn(result.value.document, 'audio')).toHaveLength(1);
  });

  it('links them explicitly in both directions', () => {
    // Explicit rather than inferred from matching asset paths: two cuts of the same file must not
    // appear linked, and inferring it would tie together clips the user deliberately separated.
    const result = paired();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [picture, sound] = result.value.clips;
    expect(picture?.kind === 'video' && picture.linkedAudio).toBe('v1_audio');
    expect(sound?.kind === 'audio' && sound.linkedVideo).toBe('v1');
  });

  it('gives both the same span, since they are one recording', () => {
    const result = paired();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [picture, sound] = result.value.clips;
    expect(sound?.span).toEqual(picture?.span);
  });

  it('refuses without a second id rather than inventing one', () => {
    // A generated id would make the same import produce a different document each time, which undo
    // comparison and a saved file both notice.
    const result = importMedia(emptyProject(), { ...request({ hasAudio: true }), linkedId: undefined });
    expect(result.ok).toBe(false);
  });
});

describe('audio and stills', () => {
  it('puts an audio file on the audio track only', () => {
    const result = importMedia(
      emptyProject(),
      request({ type: 'audio', asset: assetPath('media/tone.flac'), id: clipId('a1') }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(clipsOn(result.value.document, 'video')).toHaveLength(0);
    expect(clipsOn(result.value.document, 'audio')).toHaveLength(1);
  });

  it('gives an audio clip unity gain, centred', () => {
    const result = importMedia(emptyProject(), request({ type: 'audio', id: clipId('a1') }));
    expect(result.ok).toBe(true);
    if (result.ok && result.value.clips[0]?.kind === 'audio') {
      expect(result.value.clips[0].gain).toEqual(staticNumber(1));
      expect(result.value.clips[0].pan).toEqual(staticNumber(0));
    }
  });

  it('gives a still an authored length, since it has no intrinsic one', () => {
    const result = importMedia(
      emptyProject(),
      request({ type: 'image', durationSeconds: undefined, id: clipId('i1') }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clips[0]?.span.duration).toBe(DEFAULT_STILL_SECONDS * 30);
  });

  it('honours a requested still length', () => {
    const result = importMedia(emptyProject(), request({ type: 'image', stillFrames: 45, id: clipId('i1') }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clips[0]?.span.duration).toBe(45);
  });

  it('makes an image clip, not a video one', () => {
    const result = importMedia(emptyProject(), request({ type: 'image', id: clipId('i1') }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clips[0]?.kind).toBe('image');
  });
});

describe('rejections', () => {
  it('refuses a file with no duration rather than a zero-length clip', () => {
    const result = importMedia(emptyProject(), request({ durationSeconds: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('empty-result');
  });

  it('refuses to displace an existing clip', () => {
    // An import is no exception to the rule: silently moving material the user cannot see is the most
    // destructive thing a timeline can do.
    const occupied = withClips(emptyProject(), 'audio', [audioClip('existing', 0, 200)]);
    const result = importMedia(occupied, request({ type: 'audio', id: clipId('a1') }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'collision') {
      expect(result.error.withClip).toBe('existing');
    } else {
      throw new Error('expected a collision');
    }
  });

  it('refuses when only the paired track is blocked', () => {
    // A video whose picture fits but whose sound does not must not land half-imported.
    const occupied = withClips(emptyProject(), 'audio', [audioClip('existing', 0, 200)]);
    const result = importMedia(occupied, request({ hasAudio: true }));

    expect(result.ok).toBe(false);
  });

  it('leaves the document untouched when it refuses', () => {
    const occupied = withClips(emptyProject(), 'audio', [audioClip('existing', 0, 200)]);
    const before = JSON.stringify(occupied);
    importMedia(occupied, request({ hasAudio: true }));

    expect(JSON.stringify(occupied)).toBe(before);
  });

  it('refuses a locked track', () => {
    const base = emptyProject();
    const locked: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.kind === 'video' ? { ...track, locked: true } : track,
        ),
      },
    };
    const result = importMedia(locked, request({ hasAudio: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('track-locked');
  });

  it('names a track that is not there', () => {
    const result = importMedia(emptyProject(), request({ hasAudio: false, videoTrack: trackId('nope') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('track-not-found');
  });
});

describe('finding somewhere to land', () => {
  it('returns the playhead when it is clear', () => {
    expect(firstFreeFrame(emptyProject(), [TRACKS.video], frameIndex(90), 60)).toBe(90);
  });

  it('moves past a clip in the way', () => {
    const occupied = withClips(emptyProject(), 'audio', [audioClip('existing', 0, 200)]);
    expect(firstFreeFrame(occupied, [TRACKS.audio], frameIndex(90), 60)).toBe(200);
  });

  it('clears every track it is given, not just the first', () => {
    // A paired import needs a span free on both tracks at once; clearing them one at a time would
    // return a position that collides on the other.
    const occupied = withClips(withClips(emptyProject(), 'audio', [audioClip('a', 0, 100)]), 'video', [
      { ...audioClip('v', 100, 300), kind: 'video' },
    ]);

    const landing = firstFreeFrame(occupied, [TRACKS.video, TRACKS.audio], frameIndex(0), 60);
    expect(landing).toBe(300);
  });

  it('lands where an import then succeeds', () => {
    // The two are used together, so the answer has to be one the operation accepts.
    const occupied = withClips(emptyProject(), 'audio', [audioClip('existing', 0, 200)]);
    const at = firstFreeFrame(occupied, [TRACKS.audio], frameIndex(0), 120);

    expect(importMedia(occupied, request({ type: 'audio', id: clipId('a1'), at })).ok).toBe(true);
  });

  it('terminates on a track packed end to end', () => {
    const packed = withClips(
      emptyProject(),
      'audio',
      Array.from({ length: 50 }, (_unused, index) => audioClip(`c${index}`, index * 100, index * 100 + 100)),
    );
    expect(firstFreeFrame(packed, [TRACKS.audio], frameIndex(0), 60)).toBe(5000);
  });
});

describe('the returned clips', () => {
  it('reports picture first, so a caller can select the one a user thinks of', () => {
    const result = importMedia(emptyProject(), request({ hasAudio: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clips[0]?.kind).toBe('video');
  });

  it('reports exactly what it inserted', () => {
    const result = importMedia(emptyProject(), request({ hasAudio: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inDocument = [
      ...clipsOn(result.value.document, 'video'),
      ...clipsOn(result.value.document, 'audio'),
    ].map((clip) => clip.id);
    expect(result.value.clips.map((clip) => clip.id).sort()).toEqual([...inDocument].sort());
  });

  it('ends where the length says it should', () => {
    const result = importMedia(emptyProject(), request({ hasAudio: false, at: frameIndex(30) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(endExclusive(result.value.clips[0]!.span)).toBe(150);
  });
});
