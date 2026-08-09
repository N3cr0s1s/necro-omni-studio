import {
  type AnimatableNumber,
  type Clip,
  type ClipTransform,
  type FrameIndex,
  type FrameRate,
  type StaticValue,
  type TimelineDocument,
  type Track,
  type Transition,
  clipFade,
  containsFrame,
  endExclusive,
  evaluateAt,
  fadeAmountAt,
  frameIndex,
  shapedFadeAmount,
  framesToSecondsNumber,
  isTrackAudible,
  secondsToFrames,
  framesToSeconds,
  trackClips,
  clamp01,
} from '@nos/core';
import type {
  EffectPass,
  LayerSource,
  RenderItem,
  RenderLayer,
  RenderPlan,
  ResolvedTransform,
  TransitionPass,
  UniformValue,
} from '../contracts/render-plan.js';
import { countPasses } from '../contracts/render-plan.js';
import {
  type EffectSourceResolver,
  type EffectUniformDeclaration,
  paramKeyOf,
} from '../contracts/effect-source.js';

/**
 * Builds the render plan for one frame.
 *
 * Pure: document in, plan out. No GL, no I/O, no caching. Both the preview loop and the export loop
 * call this with the same arguments and get the same plan, which is the mechanism behind the spec's
 * WYSIWYG guarantee — there is no second code path that could drift.
 *
 * ## Layer order
 *
 * Tracks are stored in *display* order, top row first, matching the mockups where V2 sits above V1.
 * Compositing runs bottom-to-top, so video tracks are walked in reverse. Text tracks composite
 * **above all video** regardless of their row position: a title track at the bottom of the track
 * list is still a title, and burying it behind the picture would be useless. Audio tracks contribute
 * nothing visual.
 */

export interface BuildPlanOptions {
  readonly document: TimelineDocument;
  readonly frame: FrameIndex;
  readonly effects: EffectSourceResolver;
  /**
   * Rasterization cache key for a text clip, supplied by the caller.
   *
   * The compositor does not hash text itself: the key must cover exactly the non-animatable
   * properties, and that decision belongs with the text renderer that produces the texture.
   */
  readonly textCacheKey?: (clip: Clip) => string;
}

export function buildRenderPlan(options: BuildPlanOptions): RenderPlan {
  const { document, frame, effects } = options;
  const anySoloed = document.sequence.tracks.some((track) => track.solo);

  const videoTracks = document.sequence.tracks.filter((track) => track.kind === 'video');
  const textTracks = document.sequence.tracks.filter((track) => track.kind === 'text');

  const items: RenderItem[] = [];

  // Reverse display order: the topmost row composites last, so it wins.
  for (const track of [...videoTracks].reverse()) {
    items.push(...itemsForTrack(track, frame, document.frameRate, effects, anySoloed, options));
  }
  for (const track of [...textTracks].reverse()) {
    items.push(...itemsForTrack(track, frame, document.frameRate, effects, anySoloed, options));
  }

  return {
    frame,
    resolution: document.resolution,
    timeSeconds: framesToSecondsNumber(frame, document.frameRate),
    items,
    passCount: countPasses(items),
  };
}

function itemsForTrack(
  track: Track,
  frame: FrameIndex,
  rate: FrameRate,
  effects: EffectSourceResolver,
  anySoloed: boolean,
  options: BuildPlanOptions,
): readonly RenderItem[] {
  // A muted track contributes nothing. Solo inverts the rule for every other track, which is why it
  // has to be evaluated against the whole track set rather than per track.
  if (!isTrackAudible(track, anySoloed)) return [];

  // Sorted by start, because two clips on one track can be live at the same frame — that is what an
  // overlap crossfade *is* — and the document stores clips in insertion order. Unsorted, which of the
  // two ended up on top depended on the order they happened to be added in, so the same overlap
  // dissolved one way in a fresh project and the other way after a reload. The later-starting clip
  // composites last, which is what makes a dissolve read as the incoming shot arriving.
  const live = trackClips(track)
    .filter((clip) => clip.enabled && containsFrame(clip.span, frame))
    .sort((a, b) => a.span.start - b.span.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (live.length === 0) return [];

  const transitions = track.kind === 'video' ? track.transitions : [];
  const activeTransition = transitions.find((transition) => containsFrame(transition.span, frame));

  if (activeTransition !== undefined) {
    const group = buildTransitionGroup(activeTransition, live, frame, rate, effects, options);
    if (group !== undefined) return [{ kind: 'transition', group }];
    // The transition references clips that are not both live — a stale record after an edit. Fall
    // through to plain layers rather than dropping the picture.
  }

  return live.map((clip) => ({
    kind: 'layer' as const,
    layer: buildLayer(clip, frame, rate, effects, options),
  }));
}

function buildTransitionGroup(
  transition: Transition,
  live: readonly Clip[],
  frame: FrameIndex,
  rate: FrameRate,
  effects: EffectSourceResolver,
  options: BuildPlanOptions,
): { readonly from: RenderLayer; readonly to: RenderLayer; readonly transition: TransitionPass } | undefined {
  const from = live.find((clip) => clip.id === transition.from);
  const to = live.find((clip) => clip.id === transition.to);
  if (from === undefined || to === undefined) return undefined;

  const source = effects.resolve(transition.effect);
  // An unresolved transition degrades to showing the outgoing clip: the spec's passthrough rule for
  // broken effects, applied to transitions.
  if (source === undefined) return undefined;

  const span = transition.span;
  const elapsed = frame - span.start;
  // Guard against a zero-length overlap, which an edit can momentarily produce.
  const progress = span.duration === 0 ? 1 : clamp01(elapsed / span.duration);

  return {
    from: buildLayer(from, frame, rate, effects, options),
    to: buildLayer(to, frame, rate, effects, options),
    transition: {
      instance: transition.id,
      effect: transition.effect,
      progress,
      uniforms: resolveUniforms(transition.params, frameIndex(elapsed), source.uniforms),
    },
  };
}

function buildLayer(
  clip: Clip,
  frame: FrameIndex,
  rate: FrameRate,
  effects: EffectSourceResolver,
  options: BuildPlanOptions,
): RenderLayer {
  const clipRelative = frameIndex(frame - clip.span.start);

  return {
    clip: clip.id,
    source: resolveSource(clip, clipRelative, rate, options),
    transform: resolveTransform(clip, clipRelative),
    passes: resolvePasses(clip, clipRelative, effects),
    clipTimeSeconds: framesToSecondsNumber(clipRelative, rate),
    clipLengthSeconds: framesToSecondsNumber(clip.span.duration, rate),
  };
}

/**
 * Maps a clip-relative frame to the source frame to sample.
 *
 * Two conversions compose here: the speed factor, and the source's own rate. Doing them in one step
 * through seconds keeps it exact — converting to the source rate first and *then* scaling would
 * round twice and drift on a retimed clip.
 */
function resolveSource(
  clip: Clip,
  clipRelative: FrameIndex,
  rate: FrameRate,
  options: BuildPlanOptions,
): LayerSource {
  if (clip.kind === 'text') {
    const reveal = clip.reveal === undefined ? 1 : clamp01(evaluateAt(clip.reveal, clipRelative));
    return {
      kind: 'text',
      cacheKey: options.textCacheKey?.(clip) ?? clip.id,
      reveal,
    };
  }

  if (clip.kind === 'image') {
    return { kind: 'image', asset: clip.source.asset };
  }

  const speed = clip.kind === 'video' || clip.kind === 'audio' ? clip.speed.factor : 1;
  const elapsedSeconds = framesToSeconds(clipRelative, rate);
  const scaled = {
    numerator: Math.round(elapsedSeconds.numerator * speed * 1_000_000),
    denominator: elapsedSeconds.denominator * 1_000_000,
  };
  const sourceOffset = secondsToFrames(scaled, clip.source.sourceRate);

  return {
    kind: 'video',
    asset: clip.source.asset,
    sourceFrame: frameIndex(clip.source.sourceIn + sourceOffset),
    sourceRate: clip.source.sourceRate,
  };
}

function resolveTransform(clip: Clip, clipRelative: FrameIndex): ResolvedTransform {
  const transform: ClipTransform | undefined = clip.kind === 'audio' ? undefined : clip.transform;
  // A clip with no transform can still ramp, so the fade is read before the early return. A chosen
  // curve replaces the linear default rather than compounding with it.
  const amount = fadeAmountAt(clip, clipRelative);
  const fade = shapedFadeAmount(clipFade(clip), amount) ?? amount;
  if (transform === undefined) {
    return { x: 0, y: 0, scale: 1, rotation: 0, opacity: fade };
  }
  return {
    x: evaluateAt(transform.x, clipRelative),
    y: evaluateAt(transform.y, clipRelative),
    scale: evaluateAt(transform.scale, clipRelative),
    rotation: evaluateAt(transform.rotation, clipRelative),
    // Clamped: an authored curve can overshoot, and a negative or >1 opacity would produce a
    // brighter-than-source composite rather than the intended fade.
    //
    // The edge ramp **multiplies** the authored curve rather than replacing it. A clip dropped onto
    // its neighbour to make a crossfade may already carry an opacity animation, and a fade that
    // overwrote it would silently discard work; multiplying means the ramp and the animation are
    // both honoured and either can be removed without disturbing the other.
    //
    // Linear, where the mixer's is equal-power: two pictures dissolving on a sine pair are each at
    // ~0.71 in the middle and composite to a visibly *brighter* frame, because light adds where
    // uncorrelated sound does not.
    opacity: clamp01(evaluateAt(transform.opacity, clipRelative)) * fade,
  };
}

/**
 * Builds the pass list for a clip.
 *
 * Disabled effects are dropped, and an effect the resolver does not know is dropped too — the spec's
 * passthrough rule. Dropping rather than substituting a no-op program keeps the pass count honest,
 * which matters because that number drives the 8-pass warning.
 */
function resolvePasses(
  clip: Clip,
  clipRelative: FrameIndex,
  effects: EffectSourceResolver,
): readonly EffectPass[] {
  const passes: EffectPass[] = [];

  for (const instance of clip.effects) {
    if (!instance.enabled) continue;
    const source = effects.resolve(instance.effect);
    if (source === undefined) continue;

    passes.push({
      instance: instance.id,
      effect: instance.effect,
      uniforms: resolveUniforms(instance.params, clipRelative, source.uniforms),
      ...(instance.mask !== undefined ? { mask: instance.mask } : {}),
    });
  }

  return passes;
}

/**
 * Evaluates document parameters into shader uniform values at a frame.
 *
 * Keyed by **uniform name** on the way out and read by **parameter key** on the way in, because a
 * manifest may name them differently (`amount` in the document, `u_amount` in the shader). Only
 * declared parameters are emitted: a stale one left behind by an edited shader would otherwise miss
 * `getUniformLocation` on every frame, which is silent but not free.
 */
export function resolveUniforms(
  params: Readonly<Record<string, AnimatableNumber | StaticValue>>,
  frame: FrameIndex,
  declared: readonly EffectUniformDeclaration[],
): Readonly<Record<string, UniformValue>> {
  const uniforms: Record<string, UniformValue> = {};

  for (const declaration of declared) {
    const value = params[paramKeyOf(declaration)];
    if (value === undefined) continue;
    const key = declaration.name;

    switch (value.kind) {
      case 'static':
      case 'animated':
        uniforms[key] = { kind: 'float', value: evaluateAt(value, frame) };
        break;
      case 'number':
        uniforms[key] = { kind: 'float', value: value.value };
        break;
      case 'boolean':
        uniforms[key] = { kind: 'bool', value: value.value };
        break;
      case 'color':
        uniforms[key] = {
          kind: 'vec4',
          value: [value.value.r, value.value.g, value.value.b, value.value.a],
        };
        break;
      case 'string':
        // Strings cannot be uniforms. They exist for enum-style parameters the *manifest* resolves
        // into a shader variant, so they are silently skipped here rather than treated as an error.
        break;
      default:
        break;
    }
  }

  return uniforms;
}

/**
 * Whether a plan exceeds the spec's effect-stack budget.
 *
 * The spec asks for a *warning* above eight passes, not a refusal: a heavy stack is a legitimate
 * choice on a short clip, and the user is the one who knows whether the trade is worth it.
 */
export const PASS_WARNING_THRESHOLD = 8;

export function exceedsPassBudget(plan: RenderPlan): boolean {
  return plan.passCount > PASS_WARNING_THRESHOLD;
}

/** Frame range a plan is valid for, so a preview can skip rebuilding while nothing changes. */
export function planValidUntil(document: TimelineDocument, frame: FrameIndex): FrameIndex {
  let next = Number.POSITIVE_INFINITY;

  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      for (const boundary of [clip.span.start, endExclusive(clip.span)]) {
        if (boundary > frame && boundary < next) next = boundary;
      }
    }
  }

  return Number.isFinite(next) ? frameIndex(next) : frameIndex(frame + 1);
}
