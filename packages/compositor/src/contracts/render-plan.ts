import type {
  AssetPath,
  ClipId,
  EffectId,
  EffectInstanceId,
  FrameIndex,
  MaskId,
  Resolution,
  RgbaColor,
} from '@nos/core';

/**
 * The render plan: what to draw for one frame.
 *
 * A pure data description, computed from the document *before* any GL call happens. The separation
 * is deliberate and load-bearing:
 *
 * - The spec requires one compositor implementation for preview and export, so that what the user
 *   sees is what renders. Both paths build the same plan from the same document at the same frame;
 *   only the destination differs. Any divergence would have to be a bug in one shared executor
 *   rather than a difference between two code paths.
 * - Everything interesting — which clips are live, which effects are enabled, what every uniform
 *   evaluates to — is decided here, in code that needs no GL context and is therefore exhaustively
 *   testable. What remains in the GL layer is mechanical.
 */

/** Where a layer's pixels come from. */
export type LayerSource =
  /** A decoded video frame. The executor resolves the asset to a texture. */
  | {
      readonly kind: 'video';
      readonly asset: AssetPath;
      /** Frame to sample, in the *source's* own rate. */
      readonly sourceFrame: FrameIndex;
    }
  | { readonly kind: 'image'; readonly asset: AssetPath }
  /**
   * A rasterized text layer.
   *
   * `cacheKey` is the hash of the text's non-animatable properties. The spec requires an animated
   * text clip to rasterize once for its whole duration, so the executor keys its texture cache on
   * this and never re-rasterizes for a transform change.
   */
  | {
      readonly kind: 'text';
      readonly cacheKey: string;
      /** Fraction of characters revealed, for the typewriter mechanism. */
      readonly reveal: number;
    }
  | { readonly kind: 'solid'; readonly color: RgbaColor };

/** Geometry and level for a layer, already evaluated at the plan's frame. */
export interface ResolvedTransform {
  /** Normalized `[0, 1]` offset of the layer centre within the output. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  /** Degrees, clockwise. */
  readonly rotation: number;
  readonly opacity: number;
}

export type UniformValue =
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'vec2'; readonly value: readonly [number, number] }
  | { readonly kind: 'vec4'; readonly value: readonly [number, number, number, number] };

/**
 * One shader pass.
 *
 * The spec's model exactly: every effect is a single pass whose output becomes the next pass's
 * input. `uniforms` holds values already evaluated at this frame, so the executor never touches
 * the keyframe system.
 */
export interface EffectPass {
  readonly instance: EffectInstanceId;
  readonly effect: EffectId;
  readonly uniforms: Readonly<Record<string, UniformValue>>;
  /** Bound to the effect's `mask` sampler slot, if it declares one. */
  readonly mask?: MaskId;
}

/**
 * A transition pass.
 *
 * Distinct from `EffectPass` because it samples two layers rather than one, and because `progress`
 * is computed by the engine from the clips' overlap — the spec forbids exposing it as a keyframable
 * parameter, so it is not in `uniforms`.
 */
export interface TransitionPass {
  readonly instance: EffectInstanceId;
  readonly effect: EffectId;
  /** `[0, 1]` across the overlap. Engine-computed, never authored. */
  readonly progress: number;
  readonly uniforms: Readonly<Record<string, UniformValue>>;
}

export interface RenderLayer {
  readonly clip: ClipId;
  readonly source: LayerSource;
  readonly transform: ResolvedTransform;
  /** Applied in order; each pass's output is the next one's input. */
  readonly passes: readonly EffectPass[];
  /** Seconds since the clip's own start, for `u_clip_time`. */
  readonly clipTimeSeconds: number;
  readonly clipLengthSeconds: number;
}

/**
 * Two layers joined by a transition.
 *
 * Produced when clips overlap and a transition covers that overlap. Both sides are rendered with
 * their own effect stacks first, then combined — otherwise a transition would blend un-graded
 * material and the result would not match what either clip looks like alone.
 */
export interface TransitionGroup {
  readonly from: RenderLayer;
  readonly to: RenderLayer;
  readonly transition: TransitionPass;
}

export type RenderItem =
  | { readonly kind: 'layer'; readonly layer: RenderLayer }
  | { readonly kind: 'transition'; readonly group: TransitionGroup };

export interface RenderPlan {
  readonly frame: FrameIndex;
  readonly resolution: Resolution;
  /** Seconds at the plan's frame, for `u_time`. */
  readonly timeSeconds: number;
  /** Bottom to top: later items composite over earlier ones. */
  readonly items: readonly RenderItem[];
  /**
   * Total enabled passes across the plan.
   *
   * Surfaced so the UI can show the mockups' `3 pass` readout and warn above the spec's budget of 8
   * without walking the plan again.
   */
  readonly passCount: number;
}

/** Total passes a plan will execute, transitions included. */
export function countPasses(items: readonly RenderItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.kind === 'layer') {
      total += item.layer.passes.length;
    } else {
      total += item.group.from.passes.length + item.group.to.passes.length + 1;
    }
  }
  return total;
}

/** Layers in the plan, flattening transition groups. Used for texture prefetching. */
export function planLayers(plan: RenderPlan): readonly RenderLayer[] {
  return plan.items.flatMap((item) =>
    item.kind === 'layer' ? [item.layer] : [item.group.from, item.group.to],
  );
}

/** Distinct assets the plan needs decoded, so the executor can prefetch in one pass. */
export function planAssets(plan: RenderPlan): readonly AssetPath[] {
  const assets = new Set<AssetPath>();
  for (const layer of planLayers(plan)) {
    if (layer.source.kind === 'video' || layer.source.kind === 'image') {
      assets.add(layer.source.asset);
    }
  }
  return [...assets];
}
