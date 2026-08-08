import { describe, expect, it } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type VideoTrack,
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
import { type EffectSourceResolver, buildRenderPlan } from '@nos/compositor';
import {
  DEFAULT_EXPORT,
  crfFor,
  describeSettings,
  estimateSizeBytes,
  formatEstimate,
  validateExportSettings,
} from '../contracts/export-settings.js';
import {
  createProgressTracker,
  exportFrames,
  formatRemaining,
  frameCountFor,
  planExportFrame,
  resolveExportRange,
} from './export-run.js';

const effects: EffectSourceResolver = {
  resolve: (id) =>
    id === 'film_grain'
      ? {
          id: effectId('film_grain'),
          category: 'effect',
          source: 'void main() {}',
          samplers: ['source'],
          uniforms: [{ name: 'u_amount', type: 'float', paramKey: 'amount' }],
        }
      : undefined,
};

function video(id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(0),
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
    ...extra,
  } as Clip;
}

function makeDocument(clips: readonly Clip[], workRange?: { from: number; to: number }): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
  const v1: VideoTrack = { ...(base.sequence.tracks[0] as VideoTrack), clips: clips as VideoTrack['clips'] };
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: [v1, ...base.sequence.tracks.slice(1)] as TimelineDocument['sequence']['tracks'],
      ...(workRange !== undefined
        ? { workRange: spanFromBounds(frameIndex(workRange.from), frameIndex(workRange.to)) }
        : {}),
    },
  };
}

const settings = (overrides: Partial<Parameters<typeof validateExportSettings>[0]> = {}) => ({
  outputPath: 'renders/out.mp4',
  range: spanFromBounds(frameIndex(0), frameIndex(300)),
  resolution: { width: 1920, height: 1080 },
  frameRate: FRAME_RATES.WEB_30,
  ...DEFAULT_EXPORT,
  ...overrides,
});

describe('WYSIWYG guarantee', () => {
  it('builds a plan identical to the preview for the same frame', () => {
    // The spec's guarantee rests on there being no export-specific plan builder. If this ever fails, the
    // two paths have diverged and what the user auditions is no longer what renders.
    const document = makeDocument([
      video('a', 0, 200, {
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: { amount: staticNumber(0.3) },
          },
        ],
      }),
    ]);

    for (const frame of [0, 42, 199]) {
      const preview = buildRenderPlan({ document, frame: frameIndex(frame), effects });
      const exported = planExportFrame(document, frameIndex(frame), effects);
      expect(exported).toEqual(preview);
    }
  });
});

describe('frame iteration', () => {
  it('yields every frame in the range, end exclusive', () => {
    const range = spanFromBounds(frameIndex(10), frameIndex(14));
    expect([...exportFrames(range)]).toEqual([10, 11, 12, 13]);
  });

  it('yields nothing for an empty range', () => {
    expect([...exportFrames(spanFromBounds(frameIndex(5), frameIndex(5)))]).toEqual([]);
  });

  it('reports the frame count', () => {
    expect(frameCountFor(spanFromBounds(frameIndex(10), frameIndex(310)))).toBe(300);
  });

  it('is lazy, so a long export does not materialize its frame list', () => {
    // A twenty-minute export at 60 fps is 72 000 frames; building that array first buys nothing.
    const generator = exportFrames(spanFromBounds(frameIndex(0), frameIndex(1_000_000)));
    expect(generator.next().value).toBe(0);
    generator.return(undefined as never);
  });
});

describe('resolveExportRange', () => {
  it('prefers an explicit override', () => {
    const document = makeDocument([video('a', 0, 100)], { from: 10, to: 20 });
    const override = spanFromBounds(frameIndex(50), frameIndex(60));
    expect(resolveExportRange(document, override)).toBe(override);
  });

  it('uses the work range when there is one', () => {
    const document = makeDocument([video('a', 0, 1000)], { from: 100, to: 400 });
    expect(resolveExportRange(document)).toEqual(spanFromBounds(frameIndex(100), frameIndex(400)));
  });

  it('falls back to the whole sequence', () => {
    const document = makeDocument([video('a', 0, 100), video('b', 200, 350)]);
    expect(resolveExportRange(document)).toEqual(spanFromBounds(frameIndex(0), frameIndex(350)));
  });

  it('produces an empty range for an empty document rather than failing', () => {
    expect(resolveExportRange(makeDocument([])).duration).toBe(0);
  });
});

describe('settings validation', () => {
  it('accepts sane settings', () => {
    expect(validateExportSettings(settings()).ok).toBe(true);
  });

  it('reports every problem at once', () => {
    // An export is long; failing on the second problem after the first is fixed is a poor trade.
    const result = validateExportSettings(
      settings({
        outputPath: '',
        range: spanFromBounds(frameIndex(0), frameIndex(0)),
        resolution: { width: 0, height: 0 },
        audioBitrateKbps: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThanOrEqual(4);
      expect(result.error.map((issue) => issue.path)).toContain('outputPath');
    }
  });

  it('requires an mp4 extension, since the container is fixed', () => {
    const result = validateExportSettings(settings({ outputPath: 'renders/out.mov' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.message).toContain('.mp4');
  });

  it('rejects odd dimensions, which H.264 with 4:2:0 cannot encode', () => {
    // ffmpeg fails late with an opaque message, so it is caught here where the field can be named.
    const result = validateExportSettings(settings({ resolution: { width: 1921, height: 1080 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.message).toContain('even');
  });

  it('rejects an empty range', () => {
    const result = validateExportSettings(
      settings({ range: spanFromBounds(frameIndex(10), frameIndex(10)) }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('quality mapping', () => {
  it('gives H.265 a higher CRF for the same tier, since its scale is offset', () => {
    for (const quality of ['maximum', 'high', 'balanced', 'small'] as const) {
      expect(crfFor('h265', quality)).toBeGreaterThan(crfFor('h264', quality));
    }
  });

  it('increases CRF as quality decreases', () => {
    expect(crfFor('h264', 'maximum')).toBeLessThan(crfFor('h264', 'high'));
    expect(crfFor('h264', 'high')).toBeLessThan(crfFor('h264', 'balanced'));
    expect(crfFor('h264', 'balanced')).toBeLessThan(crfFor('h264', 'small'));
  });

  it('defaults to a quality that is not the slowest or the worst', () => {
    expect(DEFAULT_EXPORT.quality).toBe('high');
    expect(DEFAULT_EXPORT.speed).toBe('medium');
  });

  it('never defaults to a proxy render, which would silently ship a review copy', () => {
    expect(DEFAULT_EXPORT.useProxyResolution).toBe(false);
  });
});

describe('size estimate', () => {
  it('grows with duration', () => {
    const config = settings();
    expect(estimateSizeBytes(config, 60)).toBeGreaterThan(estimateSizeBytes(config, 10));
  });

  it('grows with quality', () => {
    expect(estimateSizeBytes(settings({ quality: 'maximum' }), 60)).toBeGreaterThan(
      estimateSizeBytes(settings({ quality: 'small' }), 60),
    );
  });

  it('is smaller for H.265 at the same tier', () => {
    expect(estimateSizeBytes(settings({ videoCodec: 'h265' }), 60)).toBeLessThan(
      estimateSizeBytes(settings({ videoCodec: 'h264' }), 60),
    );
  });

  it('grows with resolution', () => {
    expect(estimateSizeBytes(settings({ resolution: { width: 3840, height: 2160 } }), 60)).toBeGreaterThan(
      estimateSizeBytes(settings(), 60),
    );
  });

  it('formats readably', () => {
    expect(formatEstimate(500 * 1024)).toBe('500 KB');
    expect(formatEstimate(5.5 * 1024 * 1024)).toBe('5.5 MB');
    expect(formatEstimate(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });
});

describe('describeSettings', () => {
  it('summarizes the deliverable', () => {
    expect(describeSettings(settings())).toBe('1920×1080 · 30 · H.264 high');
  });

  it('names H.265 correctly', () => {
    expect(describeSettings(settings({ videoCodec: 'h265' }))).toContain('H.265');
  });
});

describe('progress tracking', () => {
  it('reports a fraction and a frame count', () => {
    const tracker = createProgressTracker(100, 0);
    for (let i = 1; i <= 25; i += 1) tracker.frameDone(i * 40);
    const progress = tracker.snapshot(1000);
    expect(progress.framesDone).toBe(25);
    expect(progress.fraction).toBeCloseTo(0.25, 6);
  });

  it('withholds an estimate until there is enough data', () => {
    // A first estimate from one sample is noise, and a wildly wrong number is worse than none.
    const tracker = createProgressTracker(100, 0);
    expect(tracker.snapshot(10).remainingSeconds).toBeUndefined();
    tracker.frameDone(10);
    expect(tracker.snapshot(20).remainingSeconds).toBeUndefined();
  });

  it('estimates from the recent rate, not the whole run', () => {
    // Export speed varies a lot between a title card and a graded shot; a whole-run average only becomes
    // accurate once it no longer matters.
    const tracker = createProgressTracker(100, 0);
    // Ten slow frames, then forty fast ones.
    let now = 0;
    for (let i = 0; i < 10; i += 1) {
      now += 500;
      tracker.frameDone(now);
    }
    for (let i = 0; i < 40; i += 1) {
      now += 20;
      tracker.frameDone(now);
    }
    const progress = tracker.snapshot(now);
    // The trailing window is all fast frames, so the estimate must reflect ~50 fps not ~10.
    expect(progress.fps).toBeGreaterThan(30);
  });

  it('caps the fraction at one even if more frames arrive than planned', () => {
    const tracker = createProgressTracker(2, 0);
    for (let i = 1; i <= 5; i += 1) tracker.frameDone(i * 10);
    expect(tracker.snapshot(100).fraction).toBe(1);
  });

  it('handles a zero-length export without dividing by zero', () => {
    expect(createProgressTracker(0, 0).snapshot(10).fraction).toBe(0);
  });

  it('carries the phase and its message', () => {
    const tracker = createProgressTracker(10, 0);
    tracker.setPhase('encoding', 'flushing the encoder');
    const progress = tracker.snapshot(100);
    expect(progress.phase).toBe('encoding');
    expect(progress.message).toBe('flushing the encoder');
  });
});

describe('formatRemaining', () => {
  it('says it is estimating before there is a number', () => {
    expect(formatRemaining(undefined)).toBe('estimating…');
  });

  it('formats seconds, minutes and both', () => {
    expect(formatRemaining(30)).toBe('about 30 s remaining');
    expect(formatRemaining(120)).toBe('about 2 min remaining');
    expect(formatRemaining(150)).toBe('about 2 min 30 s remaining');
  });

  it('never claims zero seconds remaining', () => {
    // "about 0 s remaining" reads as finished when it is not.
    expect(formatRemaining(0)).toBe('about 1 s remaining');
  });
});
