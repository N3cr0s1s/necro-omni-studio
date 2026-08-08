import {
  type AnimatableNumber,
  type Easing,
  type FrameIndex,
  type Keyframe,
  type KeyframeId,
  type TextAnimation,
  type TextAnimationPreset,
  animatedNumber,
  frameIndex,
  isAnimated,
  keyframeId,
} from '@nos/core';

/**
 * Text animation presets.
 *
 * The spec is emphatic that a preset is a **keyframe generator**, not a runtime behaviour: applying one
 * writes real keyframes the user can then edit, and there must be no hidden, non-editable animation.
 * Everything here is therefore pure — presets in, keyframes out — and nothing consults a preset at render
 * time. The `TextAnimation` record on a clip only remembers what was applied, so the UI can show which
 * preset a user chose; deleting it changes nothing about playback.
 *
 * The practical consequence, and the reason the spec insists: a user can apply "slide up", then drag one
 * marker to make it overshoot. With a runtime preset that would be impossible without adding an
 * "overshoot" option to the preset itself, and every such request compounds.
 */

/** Which transform channel a generated curve drives. */
export type AnimatedChannel = 'x' | 'y' | 'scale' | 'opacity' | 'reveal';

export interface GeneratedCurve {
  readonly channel: AnimatedChannel;
  readonly keyframes: readonly Keyframe[];
}

export interface PresetContext {
  readonly animation: TextAnimation;
  /** `in` animates from an offset to rest; `out` animates from rest to an offset. */
  readonly phase: 'in' | 'out';
  /** Clip length in frames, so an `out` animation can be anchored to the end. */
  readonly clipDurationFrames: number;
  /** Values the clip rests at, so a preset animates to the authored position rather than to zero. */
  readonly rest: RestValues;
  /** Supplies unique keyframe ids. */
  readonly nextId: () => KeyframeId;
}

export interface RestValues {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly opacity: number;
}

export const DEFAULT_REST: RestValues = { x: 0, y: 0, scale: 1, opacity: 1 };

/**
 * How far a slide travels, as a fraction of the output.
 *
 * A fraction rather than pixels so the same preset reads identically at any resolution — the transform
 * model is normalized, and a pixel offset would move a different visual distance at 4K than at 1080p.
 */
export const SLIDE_DISTANCE = 0.12;

/** How far a scale preset starts from rest. */
export const SCALE_FROM = 0.85;

/**
 * Generates the keyframes for a preset.
 *
 * Returns one curve per channel it touches, leaving every other channel alone — a `slide` must not
 * silently pin opacity, or applying "slide in" would undo a fade the user authored by hand.
 */
export function generatePreset(context: PresetContext): readonly GeneratedCurve[] {
  const { animation, phase, clipDurationFrames, rest, nextId } = context;
  const duration = Math.max(0, Math.round(animation.durationFrames));
  if (duration === 0 || animation.preset === 'none') return [];

  // An `in` runs from the clip's start; an `out` ends at its end. Clamped so a duration longer than the
  // clip degenerates to the whole clip rather than producing keyframes outside it.
  const clampedDuration = Math.min(duration, clipDurationFrames);
  const startFrame = frameIndex(phase === 'in' ? 0 : Math.max(0, clipDurationFrames - clampedDuration));
  const endFrame = frameIndex(startFrame + clampedDuration);

  const ease = normalizeEase(animation.ease);
  // An `in` eases toward rest; an `out` eases away from it. The easing lives on the *first* keyframe of
  // the pair because easing governs the segment leaving a marker.
  const pair = (from: number, to: number): readonly Keyframe[] => [
    { id: nextId(), frame: startFrame, value: phase === 'in' ? from : to, ease },
    { id: nextId(), frame: endFrame, value: phase === 'in' ? to : from, ease: 'linear' },
  ];

  switch (animation.preset) {
    case 'fade':
      return [{ channel: 'opacity', keyframes: pair(0, rest.opacity) }];

    case 'scale':
      return [
        { channel: 'scale', keyframes: pair(rest.scale * SCALE_FROM, rest.scale) },
        // Scale alone reads as the text growing out of nothing at full opacity, which looks like a glitch;
        // pairing it with a fade is what makes the preset usable.
        { channel: 'opacity', keyframes: pair(0, rest.opacity) },
      ];

    case 'slide': {
      const direction = animation.direction ?? 'up';
      const horizontal = direction === 'left' || direction === 'right';
      const channel: AnimatedChannel = horizontal ? 'x' : 'y';
      const restValue = horizontal ? rest.x : rest.y;
      // "Slide up" means the text arrives *from* below and moves up into place, which is a positive y
      // offset in a top-left origin space.
      const sign = direction === 'up' || direction === 'left' ? 1 : -1;
      return [
        { channel, keyframes: pair(restValue + SLIDE_DISTANCE * sign, restValue) },
        { channel: 'opacity', keyframes: pair(0, rest.opacity) },
      ];
    }

    case 'typewriter':
      // The one preset that drives `reveal` rather than a transform: the number of visible characters
      // changes, which no transform expresses. On the way out it un-types.
      return [{ channel: 'reveal', keyframes: pair(0, 1) }];

    default: {
      const unreachable: never = animation.preset;
      throw new Error(`Unhandled preset ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Presets the UI offers, in menu order. */
export const TEXT_PRESETS: readonly TextAnimationPreset[] = ['none', 'fade', 'slide', 'scale', 'typewriter'];

/** Directions a slide accepts. */
export const SLIDE_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

/**
 * Merges generated keyframes into an existing parameter.
 *
 * Existing keyframes *inside* the generated range are replaced — that range is what the preset defines —
 * while those outside are kept. Replacing the whole curve would silently destroy an out-animation when an
 * in-animation is applied, which is exactly the kind of data loss the spec's "no hidden animation" rule
 * is guarding against.
 */
export function mergeGeneratedKeyframes(
  existing: AnimatableNumber,
  generated: readonly Keyframe[],
): AnimatableNumber {
  if (generated.length === 0) return existing;

  const first = generated[0]!;
  const last = generated[generated.length - 1]!;

  const kept = isAnimated(existing)
    ? existing.keyframes.filter((keyframe) => keyframe.frame < first.frame || keyframe.frame > last.frame)
    : [];

  return animatedNumber([...kept, ...generated]);
}

/**
 * Removes a preset's keyframes from a parameter.
 *
 * Used when a preset is set back to `none`. Identified by frame range rather than by id, because the user
 * may have dragged the markers since — and a marker they moved is still the one the preset created.
 */
export function removeRange(
  existing: AnimatableNumber,
  fromFrame: FrameIndex,
  toFrame: FrameIndex,
): AnimatableNumber {
  if (!isAnimated(existing)) return existing;
  const kept = existing.keyframes.filter(
    (keyframe) => keyframe.frame < fromFrame || keyframe.frame > toFrame,
  );
  return kept.length === existing.keyframes.length ? existing : animatedNumber(kept);
}

/**
 * The frame range a preset occupies on a clip.
 *
 * Exported so the UI can highlight it on the keyframe lane, and so `removeRange` and the generator agree
 * on the boundaries without duplicating the arithmetic.
 */
export function presetRange(
  animation: TextAnimation,
  phase: 'in' | 'out',
  clipDurationFrames: number,
): { readonly start: FrameIndex; readonly end: FrameIndex } {
  const duration = Math.min(Math.max(0, Math.round(animation.durationFrames)), clipDurationFrames);
  const start = frameIndex(phase === 'in' ? 0 : Math.max(0, clipDurationFrames - duration));
  return { start, end: frameIndex(start + duration) };
}

/**
 * Normalizes an easing string from a manifest or an older project.
 *
 * The document stores easing as a free string on `TextAnimation` for forward compatibility, so an
 * unrecognized value degrades to linear rather than producing keyframes the evaluator cannot read.
 */
function normalizeEase(ease: string): Easing {
  const known: readonly Easing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'];
  return known.includes(ease as Easing) ? (ease as Easing) : 'linear';
}

/** Sequential keyframe id source, so generated documents round-trip byte-identically in tests. */
export function createKeyframeIdFactory(prefix = 'kf'): () => KeyframeId {
  let counter = 0;
  return () => {
    counter += 1;
    return keyframeId(`${prefix}_${String(counter).padStart(4, '0')}`);
  };
}
