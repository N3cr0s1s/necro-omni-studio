import { describe, expect, it } from 'vitest';
import {
  type AudioTrack,
  type Clip,
  type EffectId,
  type TextTrack,
  type TimelineDocument,
  type VideoTrack,
  FRAME_RATES,
  animatedNumber,
  assetPath,
  clipId,
  createDocument,
  effectId,
  effectInstanceId,
  frameIndex,
  frameRate,
  keyframeId,
  maskId,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import type { EffectShaderSource, EffectSourceResolver } from '../contracts/effect-source.js';
import { planAssets, planLayers } from '../contracts/render-plan.js';
import { PASS_WARNING_THRESHOLD, buildRenderPlan, exceedsPassBudget, planValidUntil } from './build-plan.js';

/** A resolver that knows a couple of effects and one transition. */
const effects: EffectSourceResolver = {
  resolve(id: EffectId): EffectShaderSource | undefined {
    const known: Record<string, EffectShaderSource> = {
      film_grain: {
        id: effectId('film_grain'),
        category: 'effect',
        source: 'void main() {}',
        samplers: ['source'],
        uniforms: [
          { name: 'u_amount', type: 'float' },
          { name: 'u_size', type: 'float' },
        ],
      },
      background_blur: {
        id: effectId('background_blur'),
        category: 'effect',
        source: 'void main() {}',
        samplers: ['source', 'mask'],
        uniforms: [
          { name: 'u_radius', type: 'vec4' },
          { name: 'u_invert', type: 'bool' },
        ],
      },
      crosswarp: {
        id: effectId('crosswarp'),
        category: 'transition',
        source: 'vec4 transition(vec2 uv) { return vec4(0.0); }',
        samplers: ['from', 'to'],
        convention: 'gl-transitions',
        uniforms: [{ name: 'strength', type: 'float' }],
      },
    };
    return known[id];
  },
};

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
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

interface DocOptions {
  readonly v1?: readonly Clip[];
  readonly v2?: readonly Clip[];
  readonly text?: readonly Clip[];
  readonly audio?: readonly Clip[];
  readonly transitions?: VideoTrack['transitions'];
  readonly mutateTracks?: (tracks: readonly TimelineDocument['sequence']['tracks'][number][]) => readonly TimelineDocument['sequence']['tracks'][number][];
}

/** Tracks in display order: V2 above V1, then audio, then text. */
function makeDocument(options: DocOptions = {}): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

  const v1Base = base.sequence.tracks[0] as VideoTrack;
  const v2: VideoTrack = {
    ...v1Base,
    id: trackId('v2'),
    name: 'V2',
    clips: (options.v2 ?? []) as VideoTrack['clips'],
    transitions: [],
  };
  const v1: VideoTrack = {
    ...v1Base,
    clips: (options.v1 ?? []) as VideoTrack['clips'],
    transitions: options.transitions ?? [],
  };
  const a1: AudioTrack = {
    ...(base.sequence.tracks[1] as AudioTrack),
    clips: (options.audio ?? []) as AudioTrack['clips'],
  };
  const t1: TextTrack = {
    ...(base.sequence.tracks[2] as TextTrack),
    clips: (options.text ?? []) as TextTrack['clips'],
  };

  const tracks = [v2, v1, a1, t1];
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: options.mutateTracks === undefined ? tracks : (options.mutateTracks(tracks) as typeof tracks),
    },
  };
}

const plan = (document: TimelineDocument, frame: number) =>
  buildRenderPlan({ document, frame: frameIndex(frame), effects });

describe('layer selection', () => {
  it('includes only clips live at the frame', () => {
    const document = makeDocument({ v1: [video('a', 0, 100), video('b', 200, 300)] });
    expect(plan(document, 50).items).toHaveLength(1);
    expect(plan(document, 150).items).toHaveLength(0);
    expect(plan(document, 250).items).toHaveLength(1);
  });

  it('treats the clip end as exclusive, matching the span convention', () => {
    const document = makeDocument({ v1: [video('a', 0, 100)] });
    expect(plan(document, 99).items).toHaveLength(1);
    expect(plan(document, 100).items).toHaveLength(0);
  });

  it('excludes a disabled clip', () => {
    const document = makeDocument({ v1: [video('a', 0, 100, { enabled: false })] });
    expect(plan(document, 50).items).toHaveLength(0);
  });

  it('excludes clips on a muted track', () => {
    const document = makeDocument({
      v1: [video('a', 0, 100)],
      mutateTracks: (tracks) =>
        tracks.map((track) => (track.id === 'v1' ? { ...track, muted: true } : track)),
    });
    expect(plan(document, 50).items).toHaveLength(0);
  });

  it('excludes non-soloed tracks once anything is soloed', () => {
    // Solo has to be evaluated against the whole track set, not per track.
    const document = makeDocument({
      v1: [video('a', 0, 100)],
      v2: [video('b', 0, 100)],
      mutateTracks: (tracks) =>
        tracks.map((track) => (track.id === 'v2' ? { ...track, solo: true } : track)),
    });
    const items = plan(document, 50).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind === 'layer' && items[0]!.layer.clip).toBe('b');
  });

  it('ignores audio tracks, which contribute nothing visual', () => {
    const document = makeDocument({
      audio: [
        {
          kind: 'audio',
          id: clipId('voice'),
          span: spanFromBounds(frameIndex(0), frameIndex(100)),
          label: 'voice',
          enabled: true,
          effects: [],
          source: {
            asset: assetPath('media/voice.flac'),
            sourceIn: frameIndex(0),
            sourceRate: FRAME_RATES.WEB_30,
          },
          speed: { factor: 1, preservePitch: true },
          gain: staticNumber(1),
          pan: staticNumber(0),
        } as Clip,
      ],
    });
    expect(plan(document, 50).items).toHaveLength(0);
  });
});

describe('layer order', () => {
  it('composites the topmost video row last, so it wins', () => {
    // Tracks are stored in display order, V2 first; compositing runs bottom-to-top.
    const document = makeDocument({ v1: [video('lower', 0, 100)], v2: [video('upper', 0, 100)] });
    const items = plan(document, 50).items;
    expect(items.map((item) => (item.kind === 'layer' ? item.layer.clip : 'transition'))).toEqual([
      'lower',
      'upper',
    ]);
  });

  it('composites text above all video, wherever its row sits', () => {
    // A title track at the bottom of the track list is still a title.
    const document = makeDocument({
      v1: [video('picture', 0, 100)],
      text: [
        {
          kind: 'text',
          id: clipId('title'),
          span: spanFromBounds(frameIndex(0), frameIndex(100)),
          label: 'TITLE',
          enabled: true,
          effects: [],
          content: {
            text: 'Hello',
            font: 'Inter',
            size: 48,
            weight: 600,
            color: { r: 1, g: 1, b: 1, a: 1 },
            align: 'center',
            lineHeight: 1.2,
            letterSpacing: 0,
          },
          transform,
        } as Clip,
      ],
    });
    const items = plan(document, 50).items;
    expect(items.map((item) => (item.kind === 'layer' ? item.layer.clip : '?'))).toEqual([
      'picture',
      'title',
    ]);
  });
});

describe('source frame resolution', () => {
  it('maps clip-relative frames onto the source, honouring the in-point', () => {
    const clip = video('a', 100, 200, {
      source: {
        asset: assetPath('media/a.mp4'),
        sourceIn: frameIndex(500),
        sourceRate: FRAME_RATES.WEB_30,
      },
    });
    const layer = planLayers(plan(makeDocument({ v1: [clip] }), 130))[0]!;
    expect(layer.source.kind === 'video' && layer.source.sourceFrame).toBe(530);
  });

  it('converts to the source rate when it differs from the project rate', () => {
    // 30 project frames at 30 fps is 1 s, which is 24 frames of a 24 fps source.
    const clip = video('a', 0, 100, {
      source: {
        asset: assetPath('media/a.mp4'),
        sourceIn: frameIndex(0),
        sourceRate: frameRate(24),
      },
    });
    const layer = planLayers(plan(makeDocument({ v1: [clip] }), 30))[0]!;
    expect(layer.source.kind === 'video' && layer.source.sourceFrame).toBe(24);
  });

  it('applies the speed factor', () => {
    const clip = video('a', 0, 100, { speed: { factor: 2, preservePitch: true } });
    const layer = planLayers(plan(makeDocument({ v1: [clip] }), 30))[0]!;
    // At 2x, 30 timeline frames consume 60 source frames.
    expect(layer.source.kind === 'video' && layer.source.sourceFrame).toBe(60);
  });

  it('composes speed and a differing source rate without rounding twice', () => {
    const clip = video('a', 0, 100, {
      speed: { factor: 0.5, preservePitch: true },
      source: {
        asset: assetPath('media/a.mp4'),
        sourceIn: frameIndex(0),
        sourceRate: frameRate(24),
      },
    });
    const layer = planLayers(plan(makeDocument({ v1: [clip] }), 60))[0]!;
    // 60 frames at 30 fps is 2 s; at half speed that is 1 s of source, which is 24 frames of 24 fps.
    expect(layer.source.kind === 'video' && layer.source.sourceFrame).toBe(24);
  });
});

describe('transform evaluation', () => {
  it('evaluates animated transform channels at the clip-relative frame', () => {
    const clip = video('a', 100, 200, {
      transform: {
        ...transform,
        opacity: animatedNumber([
          { id: keyframeId('k1'), frame: frameIndex(0), value: 0, ease: 'linear' },
          { id: keyframeId('k2'), frame: frameIndex(50), value: 1, ease: 'linear' },
        ]),
      },
    });
    const layer = planLayers(plan(makeDocument({ v1: [clip] }), 125))[0]!;
    // 25 frames into the clip is halfway through the fade.
    expect(layer.transform.opacity).toBeCloseTo(0.5, 6);
  });

  it('clamps opacity, so an overshooting curve cannot brighten the composite', () => {
    const clip = video('a', 0, 100, {
      transform: { ...transform, opacity: staticNumber(1.8) },
    });
    expect(planLayers(plan(makeDocument({ v1: [clip] }), 10))[0]!.transform.opacity).toBe(1);
  });

  it('gives an audio clip a neutral transform rather than failing', () => {
    const layer = planLayers(plan(makeDocument({ v1: [video('a', 0, 100)] }), 10))[0]!;
    expect(layer.transform.scale).toBe(1);
  });
});

describe('effect passes', () => {
  it('emits a pass per enabled effect, in stack order', () => {
    const clip = video('a', 0, 100, {
      effects: [
        { id: effectInstanceId('fx1'), effect: effectId('film_grain'), enabled: true, params: {} },
        {
          id: effectInstanceId('fx2'),
          effect: effectId('background_blur'),
          enabled: true,
          params: {},
        },
      ],
    });
    const layer = planLayers(plan(makeDocument({ v1: [clip] }), 10))[0]!;
    expect(layer.passes.map((pass) => pass.effect)).toEqual(['film_grain', 'background_blur']);
  });

  it('drops disabled effects', () => {
    const clip = video('a', 0, 100, {
      effects: [
        { id: effectInstanceId('fx1'), effect: effectId('film_grain'), enabled: false, params: {} },
      ],
    });
    expect(planLayers(plan(makeDocument({ v1: [clip] }), 10))[0]!.passes).toHaveLength(0);
  });

  it('drops an unknown effect instead of failing the frame', () => {
    // The spec's passthrough rule: a missing effect must not stop the render.
    const clip = video('a', 0, 100, {
      effects: [
        { id: effectInstanceId('fx1'), effect: effectId('does_not_exist'), enabled: true, params: {} },
      ],
    });
    expect(planLayers(plan(makeDocument({ v1: [clip] }), 10))[0]!.passes).toHaveLength(0);
  });

  it('carries a mask binding through to the pass', () => {
    const clip = video('a', 0, 100, {
      effects: [
        {
          id: effectInstanceId('fx1'),
          effect: effectId('background_blur'),
          enabled: true,
          params: {},
          mask: maskId('m1'),
        },
      ],
    });
    expect(planLayers(plan(makeDocument({ v1: [clip] }), 10))[0]!.passes[0]!.mask).toBe('m1');
  });

  it('evaluates animated parameters at the clip-relative frame', () => {
    const clip = video('a', 50, 200, {
      effects: [
        {
          id: effectInstanceId('fx1'),
          effect: effectId('film_grain'),
          enabled: true,
          params: {
            u_amount: animatedNumber([
              { id: keyframeId('k1'), frame: frameIndex(0), value: 0, ease: 'linear' },
              { id: keyframeId('k2'), frame: frameIndex(100), value: 1, ease: 'linear' },
            ]),
          },
        },
      ],
    });
    const pass = planLayers(plan(makeDocument({ v1: [clip] }), 100))[0]!.passes[0]!;
    expect(pass.uniforms['u_amount']).toEqual({ kind: 'float', value: 0.5 });
  });

  it('skips parameters the shader does not declare', () => {
    // A stale parameter from an edited shader would otherwise miss getUniformLocation every frame.
    const clip = video('a', 0, 100, {
      effects: [
        {
          id: effectInstanceId('fx1'),
          effect: effectId('film_grain'),
          enabled: true,
          params: { u_amount: staticNumber(0.5), u_removed: staticNumber(1) },
        },
      ],
    });
    const pass = planLayers(plan(makeDocument({ v1: [clip] }), 10))[0]!.passes[0]!;
    expect(Object.keys(pass.uniforms)).toEqual(['u_amount']);
  });

  it('maps colours to vec4 and booleans to bool', () => {
    const clip = video('a', 0, 100, {
      effects: [
        {
          id: effectInstanceId('fx1'),
          effect: effectId('background_blur'),
          enabled: true,
          params: {
            u_radius: { kind: 'color', value: { r: 1, g: 0.5, b: 0, a: 0.8 } },
            u_invert: { kind: 'boolean', value: true },
          },
        },
      ],
    });
    const pass = planLayers(plan(makeDocument({ v1: [clip] }), 10))[0]!.passes[0]!;
    expect(pass.uniforms['u_radius']).toEqual({ kind: 'vec4', value: [1, 0.5, 0, 0.8] });
    expect(pass.uniforms['u_invert']).toEqual({ kind: 'bool', value: true });
  });
});

describe('transitions', () => {
  const overlap = spanFromBounds(frameIndex(90), frameIndex(110));

  function documentWithTransition() {
    return makeDocument({
      v1: [video('a', 0, 110), video('b', 90, 200)],
      transitions: [
        {
          id: effectInstanceId('tr1'),
          effect: effectId('crosswarp'),
          span: overlap,
          from: clipId('a'),
          to: clipId('b'),
          params: { strength: staticNumber(0.4) },
        },
      ],
    });
  }

  it('produces a transition group covering the overlap', () => {
    const items = plan(documentWithTransition(), 100).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('transition');
  });

  it('computes progress from the overlap, not from a parameter', () => {
    // The spec forbids exposing transition progress as keyframable, so it must be engine-derived.
    const at = (frame: number) => {
      const item = plan(documentWithTransition(), frame).items[0]!;
      return item.kind === 'transition' ? item.group.transition.progress : NaN;
    };
    expect(at(90)).toBeCloseTo(0, 6);
    expect(at(100)).toBeCloseTo(0.5, 6);
    expect(at(109)).toBeCloseTo(0.95, 6);
  });

  it('keeps progress out of the uniform set', () => {
    const item = plan(documentWithTransition(), 100).items[0]!;
    if (item.kind !== 'transition') throw new Error('expected a transition');
    expect(Object.keys(item.group.transition.uniforms)).toEqual(['strength']);
  });

  it('renders both sides with their own effect stacks', () => {
    const item = plan(documentWithTransition(), 100).items[0]!;
    if (item.kind !== 'transition') throw new Error('expected a transition');
    expect(item.group.from.clip).toBe('a');
    expect(item.group.to.clip).toBe('b');
  });

  it('falls back to plain layers when the transition references a clip that is not live', () => {
    // A stale transition record after an edit must not blank the picture.
    const document = makeDocument({
      v1: [video('a', 0, 110)],
      transitions: [
        {
          id: effectInstanceId('tr1'),
          effect: effectId('crosswarp'),
          span: overlap,
          from: clipId('a'),
          to: clipId('missing'),
          params: {},
        },
      ],
    });
    const items = plan(document, 100).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('layer');
  });

  it('falls back when the transition effect is unknown', () => {
    const document = makeDocument({
      v1: [video('a', 0, 110), video('b', 90, 200)],
      transitions: [
        {
          id: effectInstanceId('tr1'),
          effect: effectId('unknown_transition'),
          span: overlap,
          from: clipId('a'),
          to: clipId('b'),
          params: {},
        },
      ],
    });
    expect(plan(document, 100).items.every((item) => item.kind === 'layer')).toBe(true);
  });

  it('survives a zero-length overlap that an edit can momentarily produce', () => {
    const document = makeDocument({
      v1: [video('a', 0, 110), video('b', 90, 200)],
      transitions: [
        {
          id: effectInstanceId('tr1'),
          effect: effectId('crosswarp'),
          span: spanFromBounds(frameIndex(100), frameIndex(100)),
          from: clipId('a'),
          to: clipId('b'),
          params: {},
        },
      ],
    });
    expect(() => plan(document, 100)).not.toThrow();
  });
});

describe('plan metadata', () => {
  it('reports the time in seconds for u_time', () => {
    const document = makeDocument({ v1: [video('a', 0, 100)] });
    expect(plan(document, 30).timeSeconds).toBeCloseTo(1, 6);
  });

  it('reports clip-relative time and length for u_clip_time and u_clip_length', () => {
    const document = makeDocument({ v1: [video('a', 60, 150)] });
    const layer = planLayers(plan(document, 90))[0]!;
    expect(layer.clipTimeSeconds).toBeCloseTo(1, 6);
    expect(layer.clipLengthSeconds).toBeCloseTo(3, 6);
  });

  it('counts passes across the plan, transitions included', () => {
    const document = makeDocument({
      v1: [
        video('a', 0, 100, {
          effects: [
            { id: effectInstanceId('fx1'), effect: effectId('film_grain'), enabled: true, params: {} },
          ],
        }),
      ],
      v2: [
        video('b', 0, 100, {
          effects: [
            { id: effectInstanceId('fx2'), effect: effectId('film_grain'), enabled: true, params: {} },
          ],
        }),
      ],
    });
    expect(plan(document, 10).passCount).toBe(2);
  });

  it('flags a plan over the spec pass budget without refusing it', () => {
    const many = Array.from({ length: PASS_WARNING_THRESHOLD + 1 }, (_, i) => ({
      id: effectInstanceId(`fx${i}`),
      effect: effectId('film_grain'),
      enabled: true,
      params: {},
    }));
    const document = makeDocument({ v1: [video('a', 0, 100, { effects: many })] });
    const built = plan(document, 10);
    expect(built.passCount).toBe(PASS_WARNING_THRESHOLD + 1);
    expect(exceedsPassBudget(built)).toBe(true);
    // Still a complete plan: a heavy stack is the user's call.
    expect(built.items).toHaveLength(1);
  });

  it('lists distinct assets for prefetching', () => {
    const document = makeDocument({
      v1: [video('a', 0, 100)],
      v2: [video('a2', 0, 100)],
    });
    expect(planAssets(plan(document, 10))).toHaveLength(2);
  });
});

describe('planValidUntil', () => {
  it('reports the next clip boundary, so a preview can reuse a plan', () => {
    const document = makeDocument({ v1: [video('a', 0, 100), video('b', 200, 300)] });
    expect(planValidUntil(document, frameIndex(50))).toBe(100);
    expect(planValidUntil(document, frameIndex(150))).toBe(200);
  });

  it('advances by one frame when nothing changes ahead', () => {
    const document = makeDocument({ v1: [video('a', 0, 100)] });
    expect(planValidUntil(document, frameIndex(500))).toBe(501);
  });
});

describe('determinism', () => {
  it('produces an identical plan for the same document and frame', () => {
    // The mechanism behind WYSIWYG: preview and export build the same plan, so there is no second
    // code path that could drift.
    const document = makeDocument({
      v1: [
        video('a', 0, 100, {
          effects: [
            {
              id: effectInstanceId('fx1'),
              effect: effectId('film_grain'),
              enabled: true,
              params: { u_amount: staticNumber(0.3) },
            },
          ],
        }),
      ],
    });
    expect(plan(document, 42)).toEqual(plan(document, 42));
  });
});
