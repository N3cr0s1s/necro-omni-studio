import {
  type Clip,
  type ClipId,
  type ClipSpeed,
  type ClipTransform,
  type EffectInstance,
  type EffectInstanceId,
  type Result,
  type TimelineDocument,
  type AnimatableNumber,
  clipTransform,
  err,
  locateClip,
  ok,
} from '@nos/core';
import type { EditError } from './errors.js';
import { assertUnlocked, replaceClip, replaceTrack } from './mutate.js';

/**
 * Copying a clip's look onto others.
 *
 * The gap this fills is not "an effect can be added" — it could — but that adding one to eleven clips
 * meant repeating the same eleven-step ritual and getting the parameters subtly different each time.
 * Grading a scene is the ordinary case, and doing it clip by clip is how a grade drifts.
 *
 * What travels is everything that describes *how a clip looks or sounds*, and nothing that describes
 * **which material it is or where it sits**: source, span, label, provenance and links all stay.
 * That boundary is the whole design — a "paste attributes" that moved a clip or swapped its media
 * would be indistinguishable from a bug.
 */

export interface ClipAttributes {
  /** The effect stack, with its parameters and keyframes. */
  readonly effects: readonly EffectInstance[];
  /** Absent for audio, which has no transform. */
  readonly transform?: ClipTransform;
  /** Absent for text and images, which are not retimed. */
  readonly speed?: ClipSpeed;
  /** Level and pan, for audio only. */
  readonly gain?: AnimatableNumber;
  readonly pan?: AnimatableNumber;
}

/** What a paste is allowed to touch, so a caller can move a grade without moving a fade. */
export interface AttributeSelection {
  readonly effects?: boolean;
  readonly transform?: boolean;
  readonly speed?: boolean;
  readonly audio?: boolean;
}

const EVERYTHING: Required<AttributeSelection> = {
  effects: true,
  transform: true,
  speed: true,
  audio: true,
};

/** Reads a clip's attributes. Returns nothing when the clip is gone rather than an empty look. */
export function copyAttributes(document: TimelineDocument, clip: ClipId): ClipAttributes | undefined {
  const located = locateClip(document, clip);
  if (located === undefined) return undefined;

  const source = located.clip;
  const transform = clipTransform(source);

  return {
    effects: source.effects,
    ...(transform !== undefined ? { transform } : {}),
    ...(source.kind === 'video' || source.kind === 'audio' ? { speed: source.speed } : {}),
    ...(source.kind === 'audio' ? { gain: source.gain, pan: source.pan } : {}),
  };
}

export interface PasteAttributesRequest {
  readonly targets: readonly ClipId[];
  readonly attributes: ClipAttributes;
  /**
   * New ids for the effect instances, one per target per effect.
   *
   * Supplied rather than generated, and *required* rather than optional: two clips sharing an effect
   * instance id would make the inspector's selection ambiguous and every later edit land on whichever
   * clip was found first.
   */
  readonly effectId: (target: ClipId, index: number) => EffectInstanceId;
  /** Which parts to apply. Everything, unless a caller says otherwise. */
  readonly parts?: AttributeSelection;
}

/**
 * Applies attributes to a set of clips.
 *
 * Each target takes only the parts its kind can hold — a transform copied onto an audio clip is
 * dropped rather than refused, because a user who selected a scene and pasted a look meant the look
 * to land wherever it makes sense, not to be told that one of the eleven clips was audio.
 *
 * A locked target *is* refused, because that is what locking is for, and the rest still receive it:
 * the alternative is one protected clip blocking an edit to ten unprotected ones.
 */
export function pasteAttributes(
  document: TimelineDocument,
  request: PasteAttributesRequest,
): Result<{ readonly document: TimelineDocument; readonly applied: readonly ClipId[] }, EditError> {
  const parts = { ...EVERYTHING, ...request.parts };
  let next = document;
  const applied: ClipId[] = [];
  let refusal: EditError | undefined;

  for (const target of request.targets) {
    const located = locateClip(next, target);
    if (located === undefined) continue;

    const unlocked = assertUnlocked(located.track);
    if (!unlocked.ok) {
      refusal ??= unlocked.error;
      continue;
    }

    const updated = applyTo(located.clip, request, parts);
    if (updated === located.clip) continue;

    next = replaceTrack(next, replaceClip(located.track, updated));
    applied.push(target);
  }

  // Reported only when nothing landed at all. A refusal beside nine successes is a note, not a
  // failure, and returning an error would throw away the nine.
  if (applied.length === 0 && refusal !== undefined) return err(refusal);
  return ok({ document: next, applied });
}

function applyTo(clip: Clip, request: PasteAttributesRequest, parts: Required<AttributeSelection>): Clip {
  const { attributes } = request;
  let next = clip;

  if (parts.effects) {
    next = {
      ...next,
      // Fresh ids: two clips sharing an instance id would make every later edit land on whichever
      // clip happened to be found first.
      effects: attributes.effects.map((instance, index) => ({
        ...instance,
        id: request.effectId(clip.id, index),
      })),
    } as Clip;
  }

  if (parts.transform && attributes.transform !== undefined && next.kind !== 'audio') {
    next = { ...next, transform: attributes.transform } as Clip;
  }

  if (parts.speed && attributes.speed !== undefined && (next.kind === 'video' || next.kind === 'audio')) {
    next = { ...next, speed: attributes.speed } as Clip;
  }

  if (parts.audio && next.kind === 'audio' && attributes.gain !== undefined) {
    next = {
      ...next,
      gain: attributes.gain,
      ...(attributes.pan !== undefined ? { pan: attributes.pan } : {}),
    } as Clip;
  }

  return next;
}

/**
 * A one-line description of what would be pasted.
 *
 * Named parts rather than a count: "3 effects, transform" tells a user whether this is the thing they
 * copied, where "4 attributes" tells them nothing they can check.
 */
export function describeAttributes(attributes: ClipAttributes): string {
  const parts: string[] = [];
  if (attributes.effects.length > 0) {
    parts.push(`${attributes.effects.length} effect${attributes.effects.length === 1 ? '' : 's'}`);
  }
  if (attributes.transform !== undefined) parts.push('transform');
  if (attributes.speed !== undefined && attributes.speed.factor !== 1) parts.push('speed');
  if (attributes.gain !== undefined) parts.push('level');
  return parts.length === 0 ? 'nothing to paste' : parts.join(', ');
}
