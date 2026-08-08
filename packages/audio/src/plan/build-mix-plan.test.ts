import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type AudioTrack,
  type TimelineDocument,
  FRAME_RATES,
  animatedNumber,
  assetPath,
  clipId,
  createDocument,
  frameIndex,
  frameRate,
  keyframeId,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import {
  dbToGain,
  formatDb,
  gainToDb,
  mixAssets,
  panGains,
} from '../contracts/mix-plan.js';
import {
  buildMixPlan,
  hasAudibleContent,
  isSilent,
  nextMixSpan,
  peakConcurrency,
  sourcesAtFrame,
} from './build-mix-plan.js';

const A1 = trackId('a1');
const A2 = trackId('a2');

function audioClip(
  id: string,
  start: number,
  end: number,
  overrides: Partial<AudioClip> = {},
): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.flac`),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
    },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...overrides,
  } as AudioClip;
}

interface DocOptions {
  readonly a1?: readonly AudioClip[];
  readonly a2?: readonly AudioClip[];
  readonly a1Gain?: number;
  readonly a1Pan?: number;
  readonly mutate?: (tracks: TimelineDocument['sequence']['tracks']) => TimelineDocument['sequence']['tracks'];
}

function makeDocument(options: DocOptions = {}): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: A1, text: trackId('t1') },
  });

  const a1Base = base.sequence.tracks[1] as AudioTrack;
  const a1: AudioTrack = {
    ...a1Base,
    clips: (options.a1 ?? []) as AudioTrack['clips'],
    gain: options.a1Gain ?? 1,
    pan: options.a1Pan ?? 0,
  };
  const a2: AudioTrack = {
    ...a1Base,
    id: A2,
    name: 'A2',
    clips: (options.a2 ?? []) as AudioTrack['clips'],
  };

  const tracks = [base.sequence.tracks[0]!, a1, a2, base.sequence.tracks[2]!] as TimelineDocument['sequence']['tracks'];
  return {
    ...base,
    sequence: { ...base.sequence, tracks: options.mutate === undefined ? tracks : options.mutate(tracks) },
  };
}

const plan = (document: TimelineDocument, from: number, to: number) =>
  buildMixPlan({ document, span: spanFromBounds(frameIndex(from), frameIndex(to)) });

describe('source selection', () => {
  it('includes clips overlapping the range', () => {
    const document = makeDocument({ a1: [audioClip('a', 0, 100), audioClip('b', 200, 300)] });
    expect(plan(document, 0, 150).sources.map((s) => s.clip)).toEqual(['a']);
    expect(plan(document, 0, 400).sources.map((s) => s.clip)).toEqual(['a', 'b']);
    expect(plan(document, 150, 180).sources).toHaveLength(0);
  });

  it('clips a source to the intersection, so a straddling clip is not restarted', () => {
    // Scheduling the whole clip on every block would replay its head at each boundary.
    const document = makeDocument({ a1: [audioClip('a', 0, 300)] });
    const source = plan(document, 60, 120).sources[0]!;
    expect(source.startSeconds).toBeCloseTo(2, 6);
    expect(source.durationSeconds).toBeCloseTo(2, 6);
    // Two seconds into the clip, so two seconds into the file.
    expect(source.offsetSeconds).toBeCloseTo(2, 6);
  });

  it('excludes a disabled clip', () => {
    const document = makeDocument({ a1: [audioClip('a', 0, 100, { enabled: false })] });
    expect(plan(document, 0, 100).sources).toHaveLength(0);
  });

  it('excludes a muted track', () => {
    const document = makeDocument({
      a1: [audioClip('a', 0, 100)],
      mutate: (tracks) =>
        tracks.map((track) => (track.id === A1 ? { ...track, muted: true } : track)) as typeof tracks,
    });
    expect(plan(document, 0, 100).sources).toHaveLength(0);
  });

  it('honours solo across the whole track set', () => {
    const document = makeDocument({
      a1: [audioClip('a', 0, 100)],
      a2: [audioClip('b', 0, 100)],
      mutate: (tracks) =>
        tracks.map((track) => (track.id === A2 ? { ...track, solo: true } : track)) as typeof tracks,
    });
    expect(plan(document, 0, 100).sources.map((s) => s.clip)).toEqual(['b']);
  });

  it('ignores video and text tracks', () => {
    // A video import produces a linked audio clip, so by document time all audio is on audio tracks.
    const document = makeDocument({});
    expect(plan(document, 0, 100).sources).toHaveLength(0);
  });
});

describe('gain', () => {
  it('multiplies clip gain by track gain', () => {
    const document = makeDocument({
      a1: [audioClip('a', 0, 100, { gain: staticNumber(0.5) })],
      a1Gain: 0.5,
    });
    expect(plan(document, 0, 100).sources[0]!.gain).toBeCloseTo(0.25, 6);
  });

  it('clamps a negative gain to silence rather than inverting phase', () => {
    const document = makeDocument({ a1: [audioClip('a', 0, 100, { gain: staticNumber(-1) })] });
    expect(plan(document, 0, 100).sources[0]!.gain).toBe(0);
  });

  it('emits no automation for a constant gain, so the engine can skip it', () => {
    const document = makeDocument({ a1: [audioClip('a', 0, 100)] });
    expect(plan(document, 0, 100).sources[0]!.gainAutomation).toEqual([]);
  });

  it('samples a keyframed gain into ramp points', () => {
    const document = makeDocument({
      a1: [
        audioClip('a', 0, 60, {
          gain: animatedNumber([
            { id: keyframeId('k1'), frame: frameIndex(0), value: 0, ease: 'linear' },
            { id: keyframeId('k2'), frame: frameIndex(60), value: 1, ease: 'linear' },
          ]),
        }),
      ],
    });
    const automation = plan(document, 0, 60).sources[0]!.gainAutomation;
    expect(automation.length).toBeGreaterThan(2);
    expect(automation[0]!.gain).toBeCloseTo(0, 6);
    expect(automation[automation.length - 1]!.gain).toBeCloseTo(1, 6);
  });

  it('samples an eased curve densely enough to sound curved', () => {
    // Emitting one point per keyframe would play an ease as a straight line, because Web Audio ramps
    // linearly between scheduled points.
    const document = makeDocument({
      a1: [
        audioClip('a', 0, 60, {
          gain: animatedNumber([
            { id: keyframeId('k1'), frame: frameIndex(0), value: 0, ease: 'ease-in-out' },
            { id: keyframeId('k2'), frame: frameIndex(60), value: 1, ease: 'linear' },
          ]),
        }),
      ],
    });
    const automation = plan(document, 0, 60).sources[0]!.gainAutomation;
    const midpoint = automation[Math.floor(automation.length / 2)]!;
    // An ease-in-out is near 0.5 at the midpoint but the surrounding points must not be evenly spaced in
    // value, which is what proves the curve survived sampling.
    expect(midpoint.gain).toBeGreaterThan(0.3);
    expect(midpoint.gain).toBeLessThan(0.7);
    const quarter = automation[Math.floor(automation.length / 4)]!;
    expect(quarter.gain).toBeLessThan(0.25);
  });

  it('scales automation by track gain', () => {
    const document = makeDocument({
      a1Gain: 0.5,
      a1: [
        audioClip('a', 0, 60, {
          gain: animatedNumber([
            { id: keyframeId('k1'), frame: frameIndex(0), value: 1, ease: 'linear' },
          ]),
        }),
      ],
    });
    expect(plan(document, 0, 60).sources[0]!.gainAutomation[0]!.gain).toBeCloseTo(0.5, 6);
  });

  it('always includes an endpoint on the audible boundary', () => {
    // A fade that starts a couple of frames late is audible on a short one.
    const document = makeDocument({
      a1: [
        audioClip('a', 0, 61, {
          gain: animatedNumber([
            { id: keyframeId('k1'), frame: frameIndex(0), value: 0, ease: 'linear' },
            { id: keyframeId('k2'), frame: frameIndex(61), value: 1, ease: 'linear' },
          ]),
        }),
      ],
    });
    const automation = plan(document, 0, 61).sources[0]!.gainAutomation;
    const last = automation[automation.length - 1]!;
    expect(last.atSeconds).toBeCloseTo(61 / 30, 6);
  });
});

describe('pan', () => {
  it('sums clip and track pan so they compound', () => {
    // Multiplying would pull a left-panned clip on a left-panned track back toward centre.
    const document = makeDocument({
      a1: [audioClip('a', 0, 100, { pan: staticNumber(-0.4) })],
      a1Pan: -0.3,
    });
    expect(plan(document, 0, 100).sources[0]!.pan).toBeCloseTo(-0.7, 6);
  });

  it('clamps the combined pan to the field', () => {
    const document = makeDocument({
      a1: [audioClip('a', 0, 100, { pan: staticNumber(-0.9) })],
      a1Pan: -0.9,
    });
    expect(plan(document, 0, 100).sources[0]!.pan).toBe(-1);
  });
});

describe('speed', () => {
  it('scales the source offset, since a fast clip has consumed more source', () => {
    const document = makeDocument({
      a1: [audioClip('a', 0, 300, { speed: { factor: 2, preservePitch: true } })],
    });
    // Two seconds of timeline at 2x is four seconds into the file.
    expect(plan(document, 60, 120).sources[0]!.offsetSeconds).toBeCloseTo(4, 6);
  });

  it('carries the source in-point', () => {
    const document = makeDocument({
      a1: [
        audioClip('a', 0, 300, {
          source: {
            asset: assetPath('media/a.flac'),
            sourceIn: frameIndex(90),
            sourceRate: FRAME_RATES.WEB_30,
          },
        }),
      ],
    });
    expect(plan(document, 0, 60).sources[0]!.offsetSeconds).toBeCloseTo(3, 6);
  });

  it('converts the in-point at the source rate, not the project rate', () => {
    const document = makeDocument({
      a1: [
        audioClip('a', 0, 300, {
          source: {
            asset: assetPath('media/a.flac'),
            sourceIn: frameIndex(48),
            sourceRate: frameRate(24),
          },
        }),
      ],
    });
    // 48 frames of a 24 fps source is 2 s, not 48/30.
    expect(plan(document, 0, 60).sources[0]!.offsetSeconds).toBeCloseTo(2, 6);
  });
});

describe('plan helpers', () => {
  it('lists distinct assets for prefetching', () => {
    const document = makeDocument({
      a1: [audioClip('a', 0, 100)],
      a2: [audioClip('a', 0, 100), audioClip('b', 0, 100)],
    });
    expect(mixAssets(plan(document, 0, 100))).toHaveLength(2);
  });

  it('reports a silent plan so the engine can skip scheduling', () => {
    const empty = makeDocument({});
    expect(isSilent(plan(empty, 0, 100))).toBe(true);

    const muted = makeDocument({ a1: [audioClip('a', 0, 100, { gain: staticNumber(0) })] });
    expect(isSilent(plan(muted, 0, 100))).toBe(true);

    const audible = makeDocument({ a1: [audioClip('a', 0, 100)] });
    expect(isSilent(plan(audible, 0, 100))).toBe(false);
  });

  it('reports peak concurrency, so node budgets can be checked', () => {
    const document = makeDocument({
      a1: [audioClip('a', 0, 100), audioClip('b', 50, 150)],
      a2: [audioClip('c', 60, 70)],
    });
    expect(peakConcurrency(plan(document, 0, 200))).toBe(3);
  });

  it('reports whether a document has any audible content', () => {
    expect(hasAudibleContent(makeDocument({}))).toBe(false);
    expect(hasAudibleContent(makeDocument({ a1: [audioClip('a', 0, 10)] }))).toBe(true);
  });

  it('walks forward in fixed blocks', () => {
    const first = spanFromBounds(frameIndex(0), frameIndex(30));
    const second = nextMixSpan(first, 30);
    expect([second.start, second.duration]).toEqual([30, 30]);
    // Contiguous, so nothing is skipped between blocks.
    expect(second.start).toBe(first.start + first.duration);
  });

  it('finds sources at a single frame for scrubbing', () => {
    const document = makeDocument({ a1: [audioClip('a', 0, 100), audioClip('b', 200, 300)] });
    expect(sourcesAtFrame(document, frameIndex(50)).map((s) => s.clip)).toEqual(['a']);
    expect(sourcesAtFrame(document, frameIndex(150))).toHaveLength(0);
  });
});

describe('decibel conversion', () => {
  it('round-trips through gain', () => {
    for (const db of [-40, -12, -6, -3, 0, 6]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 6);
    }
  });

  it('maps unity gain to 0 dB', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 10);
    expect(gainToDb(1)).toBeCloseTo(0, 10);
  });

  it('halves amplitude at −6 dB', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
  });

  it('maps the floor to exact silence, so a closed fader is truly silent', () => {
    expect(dbToGain(-60)).toBe(0);
    expect(dbToGain(-200)).toBe(0);
  });

  it('reports negative infinity for zero gain', () => {
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('formats the readout the way the transport bar shows it', () => {
    expect(formatDb(dbToGain(-6.2))).toBe('−6.2 dB');
    expect(formatDb(1)).toBe('0.0 dB');
    expect(formatDb(0)).toBe('−∞ dB');
  });
});

describe('pan law', () => {
  it('is equal-power, holding perceived level across the field', () => {
    // A linear law dips ~3 dB in the centre, audibly losing level as a source is panned through it.
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const { left, right } = panGains(pan);
      expect(left * left + right * right).toBeCloseTo(1, 6);
    }
  });

  it('splits equally at centre', () => {
    const { left, right } = panGains(0);
    expect(left).toBeCloseTo(Math.SQRT1_2, 6);
    expect(right).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('sends everything to one side at the extremes', () => {
    expect(panGains(-1).left).toBeCloseTo(1, 6);
    expect(panGains(-1).right).toBeCloseTo(0, 6);
    expect(panGains(1).right).toBeCloseTo(1, 6);
    expect(panGains(1).left).toBeCloseTo(0, 6);
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(panGains(-5)).toEqual(panGains(-1));
    expect(panGains(5)).toEqual(panGains(1));
    expect(panGains(NaN)).toEqual(panGains(0));
  });
});
