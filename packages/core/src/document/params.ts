import { type KeyframeId } from './ids.js';
import { type FrameIndex, frameIndex } from '../time/frame-time.js';

/**
 * Parameter animation.
 *
 * The spec's rule is that a parameter value is "either a scalar or a keyframe list,
 * evaluated per frame just before the uniform is set". That shape is modelled here once
 * and reused by clip transforms, effect parameters and text properties, so there is a
 * single evaluator and preview and export cannot diverge.
 *
 * ## Time base
 *
 * Keyframe positions are **clip-relative frame indices**, not seconds. `interfaces.md`
 * §4.5 illustrates keyframes with seconds, but §7 of the spec makes frame indices
 * mandatory for every time value, and that rule wins: seconds would reintroduce the
 * rounding drift the time layer exists to eliminate, and a keyframe that does not sit
 * exactly on a frame cannot be evaluated identically in preview and export. Seconds
 * appear only in the UI and in shader uniforms.
 *
 * ## Per-marker easing
 *
 * Easing is stored on the keyframe and governs the segment **leaving** it. That is the
 * only assignment under which `hold` reads naturally ("keep this value until the next
 * marker"), and it means the last keyframe's easing is deliberately unused.
 */
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold';

export const EASINGS: readonly Easing[] = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'hold',
];

export function isEasing(value: string): value is Easing {
  return (EASINGS as readonly string[]).includes(value);
}

export interface Keyframe {
  readonly id: KeyframeId;
  /** Clip-relative position, in frames at the project rate. */
  readonly frame: FrameIndex;
  readonly value: number;
  /** Governs the segment from this keyframe to the next. */
  readonly ease: Easing;
}

/** A parameter that is either constant or driven by keyframes. */
export type AnimatableNumber =
  | { readonly kind: 'static'; readonly value: number }
  | { readonly kind: 'animated'; readonly keyframes: readonly Keyframe[] };

/** Parameter types that cannot be animated: changing them invalidates a cache. */
export type StaticValue =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'color'; readonly value: RgbaColor };

export interface RgbaColor {
  /** Each channel in `[0, 1]`, matching what a shader uniform expects. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export type ParamValue = AnimatableNumber | StaticValue;

export function staticNumber(value: number): AnimatableNumber {
  return { kind: 'static', value };
}

/**
 * Builds an animated parameter, sorting keyframes by position.
 *
 * Sorting on construction rather than on read means the evaluator can binary-search,
 * which matters because it runs once per parameter per frame inside the render loop.
 * Two keyframes on the same frame are a degenerate authoring state rather than an
 * error; the later one in input order wins so a drag that lands on an occupied frame
 * replaces instead of throwing mid-gesture.
 */
export function animatedNumber(keyframes: readonly Keyframe[]): AnimatableNumber {
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  const deduped: Keyframe[] = [];
  for (const keyframe of sorted) {
    const previous = deduped[deduped.length - 1];
    if (previous !== undefined && previous.frame === keyframe.frame) {
      deduped[deduped.length - 1] = keyframe;
    } else {
      deduped.push(keyframe);
    }
  }
  return { kind: 'animated', keyframes: deduped };
}

export function isAnimated(
  param: AnimatableNumber,
): param is { kind: 'animated'; keyframes: readonly Keyframe[] } {
  return param.kind === 'animated';
}

/** Number of keyframes, for the `2 kf` badges the effect stack shows. */
export function keyframeCount(param: AnimatableNumber): number {
  return param.kind === 'animated' ? param.keyframes.length : 0;
}

/**
 * Applies an easing curve to a normalized `[0, 1]` segment position.
 *
 * Cubic rather than quadratic, matching the feel of the CSS keywords of the same names
 * closely enough that a user's expectation transfers. `hold` returns 0 for the whole
 * segment so the value stays at the outgoing keyframe until the next one is reached.
 */
export function applyEasing(ease: Easing, t: number): number {
  switch (ease) {
    case 'linear':
      return t;
    case 'ease-in':
      return t * t * t;
    case 'ease-out': {
      const inverted = 1 - t;
      return 1 - inverted * inverted * inverted;
    }
    case 'ease-in-out':
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'hold':
      return 0;
    default: {
      // Exhaustiveness guard: an easing added to the union without a curve here is a
      // compile error rather than a silent linear fallback.
      const unreachable: never = ease;
      throw new Error(`Unhandled easing ${String(unreachable)}`);
    }
  }
}

/**
 * Evaluates a parameter at a clip-relative frame.
 *
 * Outside the keyframe range the nearest keyframe's value is held rather than
 * extrapolated: extrapolation would send opacity past 1 or a blur radius negative when
 * a clip is trimmed longer than its animation, which reads as a bug at the UI.
 *
 * Hot path — called once per animated parameter per frame in both preview and export.
 */
export function evaluateAt(param: AnimatableNumber, frame: FrameIndex): number {
  if (param.kind === 'static') return param.value;

  const keyframes = param.keyframes;
  const count = keyframes.length;
  if (count === 0) return 0;

  const first = keyframes[0]!;
  if (frame <= first.frame) return first.value;

  const last = keyframes[count - 1]!;
  if (frame >= last.frame) return last.value;

  // Binary search for the last keyframe at or before `frame`.
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (keyframes[mid]!.frame <= frame) low = mid;
    else high = mid - 1;
  }

  const from = keyframes[low]!;
  const to = keyframes[low + 1]!;
  const span = to.frame - from.frame;
  if (span <= 0) return to.value;

  const progress = (frame - from.frame) / span;
  const eased = applyEasing(from.ease, progress);
  return from.value + (to.value - from.value) * eased;
}

/** Convenience for the many call sites that hold a plain number. */
export function evaluateAtFrameNumber(param: AnimatableNumber, frame: number): number {
  return evaluateAt(param, frameIndex(frame));
}

/**
 * Shifts every keyframe by a frame delta.
 *
 * Needed when a clip's head is trimmed: keyframes are clip-relative, so moving the in
 * point must move the animation with it or the effect would slide against the picture.
 */
export function shiftKeyframes(param: AnimatableNumber, delta: number): AnimatableNumber {
  if (param.kind === 'static') return param;
  return {
    kind: 'animated',
    keyframes: param.keyframes.map((keyframe) => ({
      ...keyframe,
      frame: frameIndex(keyframe.frame + delta),
    })),
  };
}

/**
 * Rescales keyframe positions when a clip's duration changes, preserving their
 * proportional placement. Used by a speed change, not by a trim.
 */
export function scaleKeyframes(param: AnimatableNumber, factor: number): AnimatableNumber {
  if (param.kind === 'static') return param;
  if (factor <= 0) {
    throw new RangeError(`Keyframe scale factor must be positive, received ${factor}`);
  }
  return animatedNumber(
    param.keyframes.map((keyframe) => ({
      ...keyframe,
      frame: frameIndex(Math.round(keyframe.frame * factor)),
    })),
  );
}

/** Collapses an animated parameter to a constant, sampled at one frame. */
export function freezeAt(param: AnimatableNumber, frame: FrameIndex): AnimatableNumber {
  return staticNumber(evaluateAt(param, frame));
}
