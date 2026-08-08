import { describe, expect, it } from 'vitest';
import { FRAME_RATES, frameRate } from '../time/frame-rate.js';
import { frameIndex } from '../time/frame-time.js';
import { spanFromBounds } from '../time/frame-span.js';
import { type TimelineDocument, SCHEMA_VERSION, createDocument } from '../document/document.js';
import { type AudioTrack, type TextTrack, type VideoTrack } from '../document/track.js';
import {
  assetPath,
  clipId,
  effectId,
  effectInstanceId,
  generatorId,
  jobRunId,
  keyframeId,
  maskId,
  presetId,
  projectId,
  sequenceId,
  trackId,
} from '../document/ids.js';
import { animatedNumber, staticNumber } from '../document/params.js';
import { describeLoadError, loadDocument, saveDocument } from './project-file.js';
import { serializeDocument } from './serialize.js';

function emptyDocument(): TimelineDocument {
  return createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'breakdown_v3',
    frameRate: FRAME_RATES.NTSC_29_97,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
}

/**
 * A document exercising every branch of the serializer: all four clip kinds, animated and
 * constant parameters, an effect with a mask, a transition, markers and a work range.
 */
function richDocument(): TimelineDocument {
  const base = emptyDocument();
  const videoTrack: VideoTrack = {
    kind: 'video',
    id: trackId('v1'),
    name: 'V1',
    muted: false,
    solo: false,
    locked: false,
    height: 84,
    collapsed: false,
    clips: [
      {
        kind: 'video',
        id: clipId('c1'),
        span: spanFromBounds(frameIndex(0), frameIndex(196)),
        label: 'interview_a · 01',
        enabled: true,
        source: {
          asset: assetPath('media/interview_a.mp4'),
          sourceIn: frameIndex(311),
          sourceRate: FRAME_RATES.NTSC_29_97,
        },
        transform: {
          x: staticNumber(0),
          y: staticNumber(-24),
          scale: staticNumber(1.08),
          rotation: staticNumber(0),
          opacity: animatedNumber([
            { id: keyframeId('kf1'), frame: frameIndex(0), value: 0, ease: 'ease-in-out' },
            { id: keyframeId('kf2'), frame: frameIndex(30), value: 1, ease: 'linear' },
          ]),
        },
        speed: { factor: 1, preservePitch: true },
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: {
              amount: animatedNumber([
                { id: keyframeId('kf3'), frame: frameIndex(0), value: 0.15, ease: 'linear' },
              ]),
              size: staticNumber(1),
              invert: { kind: 'boolean', value: false },
              blendMode: { kind: 'string', value: 'overlay' },
              tint: { kind: 'color', value: { r: 1, g: 0.5, b: 0.25, a: 0.8 } },
            },
            mask: maskId('m1'),
          },
        ],
        linkedAudio: clipId('c3'),
      },
      {
        kind: 'video',
        id: clipId('c2'),
        span: spanFromBounds(frameIndex(398), frameIndex(530)),
        label: 't2v_0117',
        enabled: true,
        source: {
          asset: assetPath('generated/t2v_0117_seed4471.mp4'),
          sourceIn: frameIndex(0),
          // A generated clip at a different rate than the project exercises the rebase.
          sourceRate: frameRate(24),
        },
        transform: {
          x: staticNumber(0),
          y: staticNumber(0),
          scale: staticNumber(1),
          rotation: staticNumber(0),
          opacity: staticNumber(1),
        },
        speed: { factor: 0.5, preservePitch: false },
        effects: [],
        provenance: {
          generator: generatorId('minimax_h3_t2v'),
          preset: presetId('default'),
          run: jobRunId('run_0117'),
          seed: 4471,
          createdAt: '2026-08-08T00:12:00.000Z',
        },
      },
      {
        kind: 'image',
        id: clipId('c5'),
        span: spanFromBounds(frameIndex(600), frameIndex(660)),
        label: 'still',
        enabled: false,
        source: {
          asset: assetPath('media/frame.png'),
          sourceIn: frameIndex(0),
          sourceRate: FRAME_RATES.NTSC_29_97,
        },
        transform: {
          x: staticNumber(0.5),
          y: staticNumber(0),
          scale: staticNumber(1),
          rotation: staticNumber(90),
          opacity: staticNumber(1),
        },
        effects: [],
      },
    ],
    transitions: [
      {
        id: effectInstanceId('tr1'),
        effect: effectId('crosswarp'),
        span: spanFromBounds(frameIndex(190), frameIndex(196)),
        from: clipId('c1'),
        to: clipId('c2'),
        params: { strength: staticNumber(0.4) },
      },
    ],
  };

  const audioTrack: AudioTrack = {
    kind: 'audio',
    id: trackId('a1'),
    name: 'A1 · voice',
    muted: false,
    solo: true,
    locked: false,
    height: 60,
    collapsed: false,
    gain: 0.8,
    pan: -0.2,
    clips: [
      {
        kind: 'audio',
        id: clipId('c3'),
        span: spanFromBounds(frameIndex(0), frameIndex(530)),
        label: 'interview_a · voice',
        enabled: true,
        source: {
          asset: assetPath('media/interview_a.mp4'),
          sourceIn: frameIndex(311),
          sourceRate: FRAME_RATES.NTSC_29_97,
        },
        speed: { factor: 1, preservePitch: true },
        gain: animatedNumber([
          { id: keyframeId('kf4'), frame: frameIndex(0), value: 1, ease: 'hold' },
          { id: keyframeId('kf5'), frame: frameIndex(100), value: 0, ease: 'linear' },
        ]),
        pan: staticNumber(0),
        effects: [],
        linkedVideo: clipId('c1'),
      },
    ],
  };

  const textTrack: TextTrack = {
    kind: 'text',
    id: trackId('t1'),
    name: 'T1 · text',
    muted: false,
    solo: false,
    locked: true,
    height: 46,
    collapsed: true,
    clips: [
      {
        kind: 'text',
        id: clipId('c4'),
        span: spanFromBounds(frameIndex(38), frameIndex(188)),
        label: 'TITLE',
        enabled: true,
        content: {
          text: 'A rendszer',
          font: 'Inter',
          size: 72,
          weight: 700,
          color: { r: 0.9, g: 0.75, b: 0.49, a: 1 },
          outline: { width: 2, color: { r: 0, g: 0, b: 0, a: 1 } },
          shadow: { offsetX: 0, offsetY: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.5 } },
          align: 'left',
          lineHeight: 1.4,
          letterSpacing: 0.02,
        },
        transform: {
          x: staticNumber(0.1),
          y: staticNumber(0.8),
          scale: staticNumber(1),
          rotation: staticNumber(0),
          opacity: staticNumber(1),
        },
        animateIn: { preset: 'typewriter', durationFrames: 24, ease: 'linear' },
        animateOut: { preset: 'slide', direction: 'up', durationFrames: 12, ease: 'ease-out' },
        reveal: animatedNumber([
          { id: keyframeId('kf6'), frame: frameIndex(0), value: 0, ease: 'linear' },
          { id: keyframeId('kf7'), frame: frameIndex(24), value: 1, ease: 'linear' },
        ]),
        effects: [],
      },
    ],
  };

  return {
    ...base,
    sequence: {
      id: sequenceId('s1'),
      tracks: [videoTrack, audioTrack, textTrack],
      workRange: spanFromBounds(frameIndex(902), frameIndex(1388)),
      markers: [
        { frame: frameIndex(100), label: 'beat', color: '#4c9aff' },
        { frame: frameIndex(500), label: '' },
      ],
    },
    masks: [
      {
        id: maskId('m1'),
        clip: clipId('c1'),
        span: spanFromBounds(frameIndex(10), frameIndex(150)),
        asset: assetPath('masks/m1'),
        points: [
          { frame: frameIndex(12), x: 0.5, y: 0.4, include: true },
          { frame: frameIndex(12), x: 0.1, y: 0.1, include: false },
        ],
      },
    ],
  };
}

describe('round trip', () => {
  it('preserves an empty document exactly', () => {
    const original = emptyDocument();
    const result = loadDocument(saveDocument(original));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.document).toEqual(original);
  });

  it('preserves a document using every field, so omitted defaults match schema defaults', () => {
    // This is the test that holds the two halves of the format honest: the serializer
    // omits anything equal to a default, and the schema must restore exactly that value.
    const original = richDocument();
    const result = loadDocument(saveDocument(original));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.document).toEqual(original);
  });

  it('is stable: saving a loaded document reproduces identical text', () => {
    const first = saveDocument(richDocument());
    const loaded = loadDocument(first);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(saveDocument(loaded.value.document)).toBe(first);
  });

  it('preserves the exact frame rate rather than a rounded float', () => {
    const text = saveDocument(emptyDocument());
    expect(text).toContain('"frameRate": "30000/1001"');
    const result = loadDocument(text);
    if (result.ok) {
      expect(result.value.document.frameRate.value).toEqual({
        numerator: 30000,
        denominator: 1001,
      });
    }
  });

  it('preserves a source rate that differs from the project rate', () => {
    const result = loadDocument(saveDocument(richDocument()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const track = result.value.document.sequence.tracks[0]!;
      const clip = track.clips.find((candidate) => candidate.id === 'c2');
      expect(clip?.kind === 'video' && clip.source.sourceRate.value).toEqual({
        numerator: 24,
        denominator: 1,
      });
    }
  });
});

describe('file readability', () => {
  it('writes a constant parameter as a bare number', () => {
    const json = serializeDocument(richDocument());
    const text = JSON.stringify(json);
    expect(text).toContain('"scale":1.08');
    expect(text).not.toContain('"kind":"static"');
  });

  it('omits fields equal to their defaults', () => {
    const json = serializeDocument(emptyDocument()) as Record<string, unknown>;
    const sequence = json['sequence'] as Record<string, unknown>;
    const tracks = sequence['tracks'] as readonly Record<string, unknown>[];
    // An untouched track carries only its identity and layout.
    expect(Object.keys(tracks[0]!).sort()).toEqual(['height', 'id', 'kind', 'name']);
    expect('masks' in json).toBe(false);
  });

  it('ends with a trailing newline and uses two-space indentation', () => {
    const text = saveDocument(emptyDocument());
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "id": "p1"');
  });

  it('never emits null for an absent optional field', () => {
    expect(saveDocument(richDocument())).not.toContain('null');
  });
});

describe('load failures', () => {
  it('reports malformed JSON', () => {
    const result = loadDocument('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-json');
      expect(describeLoadError(result.error)).toContain('not valid JSON');
    }
  });

  it('rejects a non-object root', () => {
    for (const text of ['[]', '42', '"a"', 'null']) {
      const result = loadDocument(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toMatch(/not-an-object|invalid-json/);
    }
  });

  it('rejects a file with no schemaVersion', () => {
    const result = loadDocument('{"id":"p1"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('migration');
      expect(describeLoadError(result.error)).toContain('no schemaVersion');
    }
  });

  it('refuses a project from a newer build instead of silently dropping its data', () => {
    const text = JSON.stringify({ ...serializeDocument(emptyDocument()), schemaVersion: 999 });
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = describeLoadError(result.error);
      expect(message).toContain('newer version');
      expect(message).toContain('discard data');
    }
  });

  it('reports every structural problem at once, each with its path', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      id: 'p1',
      frameRate: '30',
      resolution: { width: 0, height: -1 },
      sequence: { id: 's1', tracks: [{ kind: 'video', id: 'v1', height: 'tall' }] },
    });
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'invalid-document') {
      const paths = result.error.issues.map((entry) => entry.path);
      expect(paths).toContain('resolution.width');
      expect(paths).toContain('resolution.height');
      expect(paths).toContain('sequence.tracks[0].height');
      expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects an asset path that escapes the project folder', () => {
    const document = serializeDocument(richDocument()) as Record<string, unknown>;
    const text = JSON.stringify(document).replace('media/interview_a.mp4', '../../etc/passwd');
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'invalid-document') {
      expect(describeLoadError(result.error)).toContain('escape the project folder');
    }
  });

  it('rejects a non-positive speed factor that would divide by zero in the retimer', () => {
    const text = JSON.stringify(serializeDocument(richDocument())).replace('"factor":0.5', '"factor":0');
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'invalid-document') {
      expect(describeLoadError(result.error)).toContain('speed factor must be positive');
    }
  });

  it('rejects an unknown track kind, naming the discriminant', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      id: 'p1',
      frameRate: '30',
      resolution: { width: 1920, height: 1080 },
      sequence: { id: 's1', tracks: [{ kind: 'midi', id: 'x1' }] },
    });
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'invalid-document') {
      expect(result.error.issues[0]!.path).toBe('sequence.tracks[0].kind');
      expect(result.error.issues[0]!.message).toContain('unknown kind "midi"');
    }
  });
});

describe('forward compatibility', () => {
  it('ignores unknown fields, so a project touched by a newer build still opens', () => {
    const document = serializeDocument(emptyDocument()) as Record<string, unknown>;
    const text = JSON.stringify({ ...document, colorPipeline: { lut: 'aces.cube' } });
    const result = loadDocument(text);
    expect(result.ok).toBe(true);
  });

  it('degrades an unrecognized easing to linear rather than refusing the timeline', () => {
    const text = JSON.stringify(serializeDocument(richDocument())).replace(
      '"ease":"ease-in-out"',
      '"ease":"bezier"',
    );
    const result = loadDocument(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const track = result.value.document.sequence.tracks[0]!;
      const clip = track.clips.find((candidate) => candidate.id === 'c1');
      const opacity = clip?.kind === 'video' ? clip.transform.opacity : undefined;
      expect(opacity?.kind === 'animated' && opacity.keyframes[0]!.ease).toBe('linear');
    }
  });

  it('applies defaults for a minimal hand-written project file', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      id: 'p1',
      frameRate: '25',
      resolution: { width: 1920, height: 1080 },
      sequence: { id: 's1' },
    });
    const result = loadDocument(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const document = result.value.document;
      expect(document.name).toBe('Untitled');
      expect(document.sequence.tracks).toEqual([]);
      expect(document.masks).toEqual([]);
      expect(document.sequence.markers).toEqual([]);
      expect(document.sequence.workRange).toBeUndefined();
    }
  });
});

describe('migration', () => {
  it('reports no migrations for a current-version file', () => {
    const result = loadDocument(saveDocument(emptyDocument()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.migrationsApplied).toEqual([]);
  });

  it('has no gap in the chain below the current version', () => {
    // Guards the invariant that every version below the current one is reachable. When
    // SCHEMA_VERSION is bumped without registering a step, this fails immediately.
    const text = JSON.stringify({ ...serializeDocument(emptyDocument()), schemaVersion: 0 });
    const result = loadDocument(text);
    if (SCHEMA_VERSION === 1) {
      // v0 was never released, so there is deliberately no path from it.
      expect(result.ok).toBe(false);
    } else {
      expect(result.ok).toBe(true);
    }
  });
});
