import { type FrameIndex, frameIndex } from '../time/frame-time.js';
import { keyframeId } from './ids.js';
import type { KeyframeId } from './ids.js';
import type { AnimatableNumber, BezierEase, Easing, Keyframe } from './params.js';
import { CYCLED_EASINGS, animatedNumber, bezierEase, evaluateAt } from './params.js';

/**
 * Editing one keyframe.
 *
 * These are the operations the spec's §6.4 asks for — "a jelölők vízszintesen húzhatók, az érték
 * számmezőben szerkeszthető" — and until now the timeline had only half of them. A keyframe could be
 * created, moved in time, cycled through easings and deleted; its **value could not be changed**.
 *
 * That is worse than a missing control, because the inspector disables a parameter's slider once it is
 * animated — correctly, since two places writing one value is how they end up disagreeing. Between the
 * two, a value became unreachable the moment it was keyframed, and an animation could only ever hold
 * whatever number happened to be current when each marker was made. Fading a title out was not
 * expressible.
 *
 * ## Why one function and a change record
 *
 * A drag changes a frame, a field changes a value, a badge changes an easing, and all three are the
 * same edit to the caller: replace one marker, keep the list a valid animated parameter. Three
 * functions would each have to re-derive that second half, and they did — in the desktop app, where
 * they were untested. `KeyframeChange` is the same shape `editParam` uses for a manifest draft, so the
 * two read alike.
 */
export interface KeyframeChange {
  /** Clip-relative, like every keyframe position. */
  readonly frame?: FrameIndex | undefined;
  readonly value?: number | undefined;
  readonly ease?: Easing | undefined;
  /**
   * Control points for a hand-drawn curve.
   *
   * Settable without touching `ease`, so dragging a handle does not have to restate the mode, and
   * settable *with* it so switching to `bezier` can carry the curve in one edit — a marker in that
   * mode with no points would draw as a straight line the editor could not move.
   */
  readonly bezier?: BezierEase | undefined;
}

/**
 * Applies a change to one keyframe.
 *
 * Returns the parameter unchanged when the id is not on it, rather than throwing: a stale id reaches
 * here whenever an edit races the undo that removed its marker, and an exception in a pointer handler
 * would take the timeline down for something the user cannot even see.
 *
 * A non-finite value is refused for a sharper reason than tidiness. `NaN` in one keyframe propagates
 * through the interpolation to *every* frame in its two neighbouring segments, and a `NaN` uniform
 * makes a shader draw nothing — so a single stray keystroke in a number field would blank the picture
 * with no error anywhere to explain it.
 */
export function editKeyframe(
  param: AnimatableNumber,
  id: KeyframeId,
  change: KeyframeChange,
): AnimatableNumber {
  if (param.kind === 'static') return param;
  if (!param.keyframes.some((keyframe) => keyframe.id === id)) return param;
  if (change.value !== undefined && !Number.isFinite(change.value)) return param;

  const edited = param.keyframes.map((keyframe) =>
    keyframe.id === id
      ? {
          ...keyframe,
          ...(change.frame !== undefined ? { frame: frameIndex(Math.max(0, change.frame)) } : {}),
          ...(change.value !== undefined ? { value: change.value } : {}),
          ...(change.ease !== undefined ? { ease: change.ease } : {}),
          // Clamped on the way in, like everything else read from outside: the x coordinates decide
          // whether the curve runs forwards in time, and a handle dragged past the edge would
          // otherwise store a curve nothing can evaluate.
          ...(change.bezier !== undefined ? { bezier: bezierEase(change.bezier) } : {}),
        }
      : keyframe,
  );

  // Re-sorted only when a position moved. `animatedNumber` also collapses two markers that now share a
  // frame, which is what makes a drag onto an occupied frame a replacement rather than a corruption —
  // but running it for a value edit would be a sort per keystroke on the hot path.
  return change.frame === undefined ? { kind: 'animated', keyframes: edited } : animatedNumber(edited);
}

/**
 * Adds a keyframe, taking the parameter's current value at that frame unless one is given.
 *
 * Sampling the existing curve rather than a default is what makes the gesture mean "let me edit this
 * instant": adding a marker in the middle of an animation must not change what the animation does.
 */
export function addKeyframeAt(param: AnimatableNumber, frame: FrameIndex, value?: number): AnimatableNumber {
  const at = frameIndex(Math.max(0, frame));
  if (param.kind === 'animated' && param.keyframes.some((keyframe) => keyframe.frame === at)) {
    return param;
  }

  const sampled = value ?? evaluateAt(param, at);
  if (!Number.isFinite(sampled)) return param;

  const keyframe: Keyframe = {
    // Position-derived, so two markers can never share an id — and adding at an occupied frame is
    // refused above, which is what makes that true rather than merely likely.
    id: keyframeId(`kf_${at}`),
    frame: at,
    value: sampled,
    ease: 'linear',
  };

  return animatedNumber([...(param.kind === 'animated' ? param.keyframes : []), keyframe]);
}

/**
 * Removes a keyframe.
 *
 * A parameter left with one keyframe stays animated, which is meaningful: it holds that value and the
 * user can add a second. Collapsing it to a constant would quietly discard the easing they chose.
 */
export function removeKeyframe(param: AnimatableNumber, id: KeyframeId): AnimatableNumber {
  if (param.kind === 'static') return param;
  return animatedNumber(param.keyframes.filter((keyframe) => keyframe.id !== id));
}

/**
 * The next easing in the cycle, applied to one marker.
 *
 * Cycling rather than opening a menu: five options is few enough that clicking through them is faster
 * than a picker, and it keeps the badge a single control. `bezier` is deliberately not in the cycle —
 * a curve is four numbers, and landing on it by clicking a badge would put the user in a mode whose
 * controls are elsewhere, on a first curve indistinguishable from linear. Anything not in the cycle,
 * including a curve and an easing this build does not recognize, restarts at `linear`.
 */
export function cycleKeyframeEasing(param: AnimatableNumber, id: KeyframeId): AnimatableNumber {
  const current = keyframeById(param, id);
  if (current === undefined) return param;

  const index = CYCLED_EASINGS.indexOf(current.ease);
  return editKeyframe(param, id, {
    ease: CYCLED_EASINGS[(index + 1) % CYCLED_EASINGS.length] ?? 'linear',
  });
}

/** One keyframe by id, for a caller that needs to show what it is about to change. */
export function keyframeById(param: AnimatableNumber, id: KeyframeId): Keyframe | undefined {
  if (param.kind === 'static') return undefined;
  return param.keyframes.find((keyframe) => keyframe.id === id);
}
