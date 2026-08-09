import {
  type Clip,
  type ClipId,
  type ClipSpeed,
  type Result,
  type TimelineDocument,
  type Track,
  err,
  frameIndex,
  linkedPartner,
  locateClip,
  ok,
  spanFromBounds,
  trackClips,
} from '@nos/core';
import type { EditError } from './errors.js';

/**
 * Retiming a clip.
 *
 * The whole pipeline already honoured `ClipSpeed`: the compositor scales its source read through
 * seconds so a retimed clip does not drift, the mix plan scales both the offset and the rate, the
 * filmstrip draws half as much material for a half-speed clip, and the serializer round-trips it.
 * Nothing could **set** it, so every clip in every project sat at 1× forever — the same shape of gap
 * as the mask that could never reach an effect.
 *
 * ## Two ways to retime, and why both exist
 *
 * Changing the factor alone keeps the clip where it is on the timeline and changes *what plays there*:
 * at 2× the same slot shows twice as much material. That is the model's own stated meaning — "retimes
 * the source read, not the timeline placement" — and it is what you want when a shot has to fit a slot
 * that is already cut to music.
 *
 * `fitDuration` instead keeps the *material* and changes the length, which is what "slow this shot
 * down" usually means: the same footage, taking longer. It can collide with whatever is next, so it
 * returns a `Result` and names the clip in the way.
 *
 * Neither is a superset of the other and neither is a safe default for the other's case, so the caller
 * says which it means.
 *
 * ## Linked audio follows
 *
 * A video clip retimed without its linked audio is a clip whose sound drifts out of sync a little more
 * with every second — the defect is small at first and unfixable later, because by then the two have
 * different lengths and no record of having been one thing. §3 makes the link explicit precisely so
 * operations like this can honour it.
 */

/** The slowest and fastest a clip may be played. */
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;

export interface SpeedChanges {
  /** Playback multiplier. Clamped to [MIN_SPEED, MAX_SPEED]. */
  readonly factor?: number;
  readonly preservePitch?: boolean;
}

export interface SpeedOptions {
  /**
   * Keep the material rather than the length: the clip grows as it slows and shrinks as it speeds up.
   *
   * Off by default, matching the model's stated meaning and the one behaviour that can never collide.
   */
  readonly fitDuration?: boolean;
}

/** Whether a clip can be retimed at all. Stills and titles have no source rate to scale. */
export function canRetime(clip: Clip): clip is Extract<Clip, { kind: 'video' | 'audio' }> {
  return clip.kind === 'video' || clip.kind === 'audio';
}

/** The speed a clip is playing at, or 1 for kinds that cannot be retimed. */
export function speedOf(clip: Clip): ClipSpeed {
  return canRetime(clip) ? clip.speed : { factor: 1, preservePitch: true };
}

/**
 * How long a clip must be to show the same material at a new speed.
 *
 * At half speed the same footage takes twice as long, so the duration scales by the ratio of the old
 * factor to the new one. At least one frame, because a clip of no length is one nothing can select to
 * undo.
 */
export function fittedDuration(clip: Clip, factor: number): number {
  const current = speedOf(clip).factor;
  return Math.max(1, Math.round(((clip.span.duration as number) * current) / factor));
}

export function setClipSpeed(
  document: TimelineDocument,
  id: ClipId,
  changes: SpeedChanges,
  options: SpeedOptions = {},
): Result<TimelineDocument, EditError> {
  const found = locateClip(document, id);
  if (found === undefined) return err({ kind: 'clip-not-found', clip: id });
  if (found.track.locked) return err({ kind: 'track-locked', track: found.track.id });

  if (!canRetime(found.clip)) {
    return err({
      kind: 'wrong-track-kind',
      track: found.track.id,
      accepts: ['video', 'audio'],
      received: found.clip.kind,
    });
  }

  const factor = clampSpeed(changes.factor ?? found.clip.speed.factor);
  const speed: ClipSpeed = {
    factor,
    preservePitch: changes.preservePitch ?? found.clip.speed.preservePitch,
  };

  /*
   * The clip and whatever is linked to it, retimed as one gesture.
   *
   * Collected before anything is written so a collision on *either* refuses the whole edit. Applying
   * the picture and then discovering the sound cannot follow would leave exactly the drift this exists
   * to prevent, and it would be committed.
   */
  const partner = linkedPartner(found.clip);
  const targets = [id, ...(partner === undefined ? [] : [partner])];

  let next = document;
  for (const target of targets) {
    const applied = retimeOne(next, target, speed, options.fitDuration === true);
    if (!applied.ok) return applied;
    next = applied.value;
  }

  return ok(next);
}

function retimeOne(
  document: TimelineDocument,
  id: ClipId,
  speed: ClipSpeed,
  fitDuration: boolean,
): Result<TimelineDocument, EditError> {
  const found = locateClip(document, id);
  // A link pointing at a clip that is no longer there is not an error the user can act on: the
  // picture is still retimed, and refusing would make a stale link block an ordinary edit.
  if (found === undefined || !canRetime(found.clip)) return ok(document);
  if (found.track.locked) return err({ kind: 'track-locked', track: found.track.id });

  const duration = fitDuration
    ? fittedDuration(found.clip, speed.factor)
    : (found.clip.span.duration as number);

  const span = spanFromBounds(
    found.clip.span.start,
    frameIndex((found.clip.span.start as number) + duration),
  );

  if (fitDuration) {
    const blocking = firstCollision(found.track, span, id);
    if (blocking !== undefined) {
      return err({ kind: 'collision', track: found.track.id, withClip: blocking });
    }
  }

  const retimed = { ...found.clip, speed, span } as Clip;
  return ok(replaceClip(document, found.track, retimed));
}

function clampSpeed(factor: number): number {
  // A non-finite factor would serialize as `null` and be rejected on the way back in, so it is
  // treated as "no change was expressible" rather than allowed to reach the document.
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(Math.max(factor, MIN_SPEED), MAX_SPEED);
}

/** The first clip a span would overlap, ignoring the one being changed. */
function firstCollision(track: Track, span: ReturnType<typeof spanFromBounds>, ignore: ClipId) {
  const start = span.start as number;
  const end = start + (span.duration as number);

  return trackClips(track).find((clip) => {
    if (clip.id === ignore) return false;
    const clipStart = clip.span.start as number;
    return clipStart < end && start < clipStart + (clip.span.duration as number);
  })?.id;
}

function replaceClip(document: TimelineDocument, track: Track, clip: Clip): TimelineDocument {
  return {
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((entry) =>
        entry.id !== track.id
          ? entry
          : ({
              ...entry,
              clips: trackClips(entry).map((existing) => (existing.id === clip.id ? clip : existing)),
            } as Track),
      ),
    },
  };
}
