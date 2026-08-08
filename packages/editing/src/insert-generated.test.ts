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
  generatorId,
  jobRunId,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import {
  type InsertGeneratedRequest,
  insertGenerated,
  previewInsertTrack,
  trackEnd,
} from './insert-generated.js';

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

function withClips(document: TimelineDocument, track: string, clips: readonly Clip[]): TimelineDocument {
  return {
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((entry) =>
        entry.id === track ? ({ ...entry, clips } as Track) : entry,
      ),
    },
  };
}

const provenance = {
  generator: generatorId('tts'),
  run: jobRunId('r1'),
  seed: 4471,
  createdAt: '2026-08-08T00:00:00.000Z',
};

function request(overrides: Partial<InsertGeneratedRequest> = {}): InsertGeneratedRequest {
  return {
    asset: assetPath('generated/take.flac'),
    kind: 'audio',
    sourceRate: FRAME_RATES.WEB_30,
    length: 60,
    at: frameIndex(100),
    track: TRACKS.audio,
    duration: 'declared',
    id: clipId('gen1'),
    label: 'Narration',
    provenance,
    ...overrides,
  };
}

describe('landing a variant', () => {
  it('places it where it was staged', () => {
    const result = insertGenerated(emptyProject(), request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.clip.span).toEqual(spanFromBounds(frameIndex(100), frameIndex(160)));
    expect(result.value.track).toBe(TRACKS.audio);
    expect(result.value.createdTrack).toBe(false);
  });

  it('carries the provenance, which is what makes it reproducible and colours it generated', () => {
    const result = insertGenerated(emptyProject(), request());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clip.provenance).toEqual(provenance);
  });

  it('keeps the output´s own rate on the clip', () => {
    // A generator producing 24 fps video onto a 30 fps timeline retimes exactly only if the source rate
    // survives the insert.
    const result = insertGenerated(
      emptyProject(),
      request({ kind: 'video', track: TRACKS.video, sourceRate: FRAME_RATES.FILM_24 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.value.clip.kind === 'video') {
      expect(result.value.clip.source.sourceRate).toEqual(FRAME_RATES.FILM_24);
    }
  });

  it('builds a video clip with a neutral transform', () => {
    const result = insertGenerated(emptyProject(), request({ kind: 'video', track: TRACKS.video }));
    expect(result.ok).toBe(true);
    if (result.ok && result.value.clip.kind === 'video') {
      expect(result.value.clip.transform.opacity).toEqual(staticNumber(1));
      expect(result.value.clip.transform.scale).toEqual(staticNumber(1));
    }
  });

  it('builds an audio clip at unity gain, centred', () => {
    const result = insertGenerated(emptyProject(), request());
    expect(result.ok).toBe(true);
    if (result.ok && result.value.clip.kind === 'audio') {
      expect(result.value.clip.gain).toEqual(staticNumber(1));
      expect(result.value.clip.pan).toEqual(staticNumber(0));
    }
  });

  it('refuses a zero-length output rather than inserting an invisible clip', () => {
    expect(insertGenerated(emptyProject(), request({ length: 0 })).ok).toBe(false);
  });

  it('refuses a track of the wrong kind', () => {
    const result = insertGenerated(emptyProject(), request({ kind: 'audio', track: TRACKS.video }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('wrong-track-kind');
  });

  it('refuses a locked track', () => {
    const document = emptyProject();
    const locked = {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) =>
          track.id === TRACKS.audio ? { ...track, locked: true } : track,
        ),
      },
    };
    const result = insertGenerated(locked, request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('track-locked');
  });
});

describe('a declared length lands exactly where it was staged', () => {
  it('reports a collision rather than moving anything', () => {
    // The placeholder occupied that span while the job ran, so the user could see it. A collision there
    // is a genuine conflict, not something to work around behind their back.
    const document = withClips(emptyProject(), TRACKS.audio, [audioClip('existing', 120, 200)]);
    const result = insertGenerated(document, request({ duration: 'declared' }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'collision') {
      expect(result.error.withClip).toBe('existing');
    } else {
      throw new Error('expected a collision');
    }
  });

  it('does not create a track to escape the collision', () => {
    const document = withClips(emptyProject(), TRACKS.audio, [audioClip('existing', 0, 500)]);
    const result = insertGenerated(document, request({ duration: 'declared' }));
    expect(result.ok).toBe(false);
  });
});

describe('a discovered length never shifts existing clips', () => {
  it('moves to a free track of the same kind', () => {
    // The spec's rule, and the reason it exists: a narration must never rearrange a video cut.
    const base = emptyProject();
    const withSecondTrack: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: [
          ...base.sequence.tracks,
          { ...base.sequence.tracks[1]!, id: trackId('A2'), name: 'A2', clips: [] } as Track,
        ],
      },
    };
    const occupied = withClips(withSecondTrack, TRACKS.audio, [audioClip('existing', 0, 500)]);

    const result = insertGenerated(occupied, request({ duration: 'discovered' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.track).toBe('A2');
    expect(result.value.createdTrack).toBe(false);
  });

  it('creates a track when every one of its kind is occupied', () => {
    const document = withClips(emptyProject(), TRACKS.audio, [audioClip('existing', 0, 500)]);
    const result = insertGenerated(document, request({ duration: 'discovered' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.createdTrack).toBe(true);
    expect(result.value.document.sequence.tracks).toHaveLength(4);
  });

  it('leaves the existing clip exactly where it was', () => {
    // The assertion the whole rule exists for.
    const existing = audioClip('existing', 0, 500);
    const document = withClips(emptyProject(), TRACKS.audio, [existing]);
    const result = insertGenerated(document, request({ duration: 'discovered' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.value.document.sequence.tracks.find((track) => track.id === TRACKS.audio);
    expect(after?.clips[0]?.span).toEqual(existing.span);
  });

  it('names a created track after the ones already there', () => {
    // A track appearing with a generated-looking name reads as something the application did *to* the
    // user rather than something they asked for.
    const document = withClips(emptyProject(), TRACKS.audio, [audioClip('existing', 0, 500)]);
    const result = insertGenerated(document, request({ duration: 'discovered' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const created = result.value.document.sequence.tracks.at(-1);
      expect(created?.name).toBe('A2');
    }
  });

  it('takes the caller´s id for a created track, keeping the operation pure', () => {
    const document = withClips(emptyProject(), TRACKS.audio, [audioClip('existing', 0, 500)]);
    const result = insertGenerated(
      document,
      request({ duration: 'discovered', spareTrackIds: [trackId('generated-a2')] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.track).toBe('generated-a2');
  });

  it('gives a created audio track unity gain, so it changes nothing about the sound', () => {
    const document = withClips(emptyProject(), TRACKS.audio, [audioClip('existing', 0, 500)]);
    const result = insertGenerated(document, request({ duration: 'discovered' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const created = result.value.document.sequence.tracks.at(-1);
      expect(created?.kind === 'audio' && created.gain).toBe(1);
    }
  });

  it('skips a locked track when looking for room', () => {
    const base = emptyProject();
    const twoTracks: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: [
          ...base.sequence.tracks,
          { ...base.sequence.tracks[1]!, id: trackId('A2'), name: 'A2', clips: [], locked: true } as Track,
        ],
      },
    };
    const occupied = withClips(twoTracks, TRACKS.audio, [audioClip('existing', 0, 500)]);

    const result = insertGenerated(occupied, request({ duration: 'discovered' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.createdTrack).toBe(true);
  });
});

describe('previewing where it will land', () => {
  it('names the requested track when it is free', () => {
    const preview = previewInsertTrack(emptyProject(), {
      kind: 'audio',
      at: frameIndex(100),
      length: 60,
      track: TRACKS.audio,
      duration: 'discovered',
    });
    expect(preview).toEqual({ track: TRACKS.audio, createsTrack: false });
  });

  it('warns that a track will be created', () => {
    // Shown before the run, so a user is not surprised by a new track appearing when it finishes.
    const document = withClips(emptyProject(), TRACKS.audio, [audioClip('existing', 0, 500)]);
    const preview = previewInsertTrack(document, {
      kind: 'audio',
      at: frameIndex(100),
      length: 60,
      track: TRACKS.audio,
      duration: 'discovered',
    });
    expect(preview.createsTrack).toBe(true);
  });

  it('reports no destination for a blocked declared insert', () => {
    const document = withClips(emptyProject(), TRACKS.audio, [audioClip('existing', 0, 500)]);
    const preview = previewInsertTrack(document, {
      kind: 'audio',
      at: frameIndex(100),
      length: 60,
      track: TRACKS.audio,
      duration: 'declared',
    });
    expect(preview).toEqual({ track: undefined, createsTrack: false });
  });
});

describe('trackEnd', () => {
  it('reports where material stops', () => {
    const document = withClips(emptyProject(), TRACKS.audio, [
      audioClip('a', 0, 100),
      audioClip('b', 200, 300),
    ]);
    const track = document.sequence.tracks.find((entry) => entry.id === TRACKS.audio)!;
    expect(trackEnd(track)).toBe(300);
  });

  it('reports zero for an empty track', () => {
    const track = emptyProject().sequence.tracks[1]!;
    expect(trackEnd(track)).toBe(0);
  });
});
