import type { AnimatableNumber, Clip, ClipId, ClipTransform, Result, TimelineDocument } from '@nos/core';
import { ok, staticNumber } from '@nos/core';
import type { EditError } from './errors.js';
import { updateClip } from './mutate.js';

/**
 * Framing a clip: where it sits, how big it is, how it is turned, how much of it shows.
 *
 * The compositor has evaluated all five channels per frame since M4 and the shader honours every one
 * of them — and until now nothing in the application could write any of them. A clip was pinned at the
 * centre, unscaled, unrotated and fully opaque forever, which also meant the spec's §6.5 "pozíció" for
 * a title had no control, and that opacity — the one channel every fade needs — was reachable only by
 * a text preset generating keyframes.
 *
 * ## Units
 *
 * `x` and `y` are **fractions of the frame**, not pixels: the shader works in a centred,
 * aspect-corrected space, so `0.25` moves a layer a quarter of the frame's width right regardless of
 * the project's resolution. Storing pixels would make a project's framing wrong the moment its
 * resolution changed, which is a thing the project settings allow.
 *
 * `rotation` is in **degrees**, clockwise; the radians conversion belongs at the GL boundary and lives
 * there. `scale` is a multiplier. `opacity` is `[0, 1]`, and the compositor clamps it — an authored
 * curve is allowed to overshoot without producing a layer brighter than itself.
 */

/** The channels, in the order an inspector should show them: place, then size, then turn, then show. */
export const TRANSFORM_CHANNELS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

export type TransformChannel = (typeof TRANSFORM_CHANNELS)[number];

/**
 * What each channel means to a control.
 *
 * A description rather than a component, so the inspector, the keyframe lane and anything later read
 * the same limits. The bounds are what a *slider* should span, not a rule the document enforces:
 * scaling to 8× or spinning past a full turn is legitimate, and a number field allows both.
 */
export interface TransformChannelSpec {
  readonly channel: TransformChannel;
  readonly label: string;
  /** Suggested slider minimum. Not a constraint. */
  readonly min: number;
  /** Suggested slider maximum. Not a constraint. */
  readonly max: number;
  readonly step: number;
  /** The value a reset returns to, and the value a clip is created with. */
  readonly neutral: number;
  /** Shown beside the number, so a fraction is not mistaken for pixels. */
  readonly unit?: string;
}

export const TRANSFORM_SPECS: readonly TransformChannelSpec[] = [
  { channel: 'x', label: 'x', min: -1, max: 1, step: 0.01, neutral: 0, unit: 'frame' },
  { channel: 'y', label: 'y', min: -1, max: 1, step: 0.01, neutral: 0, unit: 'frame' },
  { channel: 'scale', label: 'scale', min: 0, max: 4, step: 0.01, neutral: 1, unit: '×' },
  { channel: 'rotation', label: 'rotation', min: -180, max: 180, step: 1, neutral: 0, unit: '°' },
  { channel: 'opacity', label: 'opacity', min: 0, max: 1, step: 0.01, neutral: 1 },
];

export function transformSpec(channel: TransformChannel): TransformChannelSpec {
  // Never undefined: the list is exhaustive over the union, and a lookup that could fail would make
  // every call site handle a case that cannot happen.
  return TRANSFORM_SPECS.find((spec) => spec.channel === channel) ?? TRANSFORM_SPECS[4]!;
}

/**
 * The transform of a clip, or `undefined` for one that has none.
 *
 * Audio clips have no framing — there is nothing to place — and asking for theirs is a normal thing
 * for an inspector bound to whatever is selected to do.
 */
export function clipTransform(clip: Clip): ClipTransform | undefined {
  return clip.kind === 'audio' ? undefined : clip.transform;
}

/**
 * Replaces one channel.
 *
 * Takes an `AnimatableNumber` rather than a plain number so that the same function serves the
 * inspector's field, the animate toggle, and the keyframe lane's edits — the three write the same
 * place, and three ways of writing it is how they come to disagree about what a clip's opacity is.
 *
 * Goes through `updateClip`, so framing a clip on a locked track is refused with a reason like every
 * other edit. A clip with no transform is *not* an error: an inspector bound to the selection asks
 * about whatever is selected, and an audio clip simply has nothing to place.
 */
export function setTransformChannel(
  document: TimelineDocument,
  clip: ClipId,
  channel: TransformChannel,
  value: AnimatableNumber,
): Result<TimelineDocument, EditError> {
  return updateClip(document, clip, (current) =>
    ok(
      current.kind === 'audio'
        ? current
        : { ...current, transform: { ...current.transform, [channel]: value } },
    ),
  );
}

/**
 * Returns every channel to neutral, discarding any animation on them.
 *
 * Offered because framing is the one thing a user experiments with and wants to abandon: dragging a
 * clip back to exactly centre and exactly 1× by hand is not possible, and being a hundredth off is
 * invisible until it is composited against something that is not.
 */
export function resetTransform(
  document: TimelineDocument,
  clip: ClipId,
): Result<TimelineDocument, EditError> {
  return updateClip(document, clip, (current) =>
    ok(current.kind === 'audio' ? current : { ...current, transform: neutralTransform() }),
  );
}

/** A transform that changes nothing, for a reset and for a newly created clip. */
export function neutralTransform(): ClipTransform {
  return {
    x: staticNumber(transformSpec('x').neutral),
    y: staticNumber(transformSpec('y').neutral),
    scale: staticNumber(transformSpec('scale').neutral),
    rotation: staticNumber(transformSpec('rotation').neutral),
    opacity: staticNumber(transformSpec('opacity').neutral),
  };
}

/** Whether a clip's framing differs from neutral, so an inspector can offer the reset honestly. */
export function isTransformed(clip: Clip): boolean {
  const transform = clipTransform(clip);
  if (transform === undefined) return false;

  return TRANSFORM_CHANNELS.some((channel) => {
    const value = transform[channel];
    return value.kind !== 'static' || value.value !== transformSpec(channel).neutral;
  });
}
