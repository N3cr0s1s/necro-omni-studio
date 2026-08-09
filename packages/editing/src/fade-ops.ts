import {
  type Clip,
  type ClipFade,
  type ClipId,
  type FrameSpan,
  type Result,
  type TimelineDocument,
  type TrackId,
  clipFade,
  endExclusive,
  err,
  intersection,
  ok,
  trackClips,
} from '@nos/core';
import type { EditError } from './errors.js';
import { assertUnlocked, locateClipOrFail, replaceClip, replaceTrack } from './mutate.js';

/**
 * Fades, and the crossfade that overlapping two clips makes.
 *
 * The report this answers is short and exact: *"making a crossfade is bloody hard, and it bothers me
 * that I cannot lay two videos or two sounds over each other. If I overlap two of them a crossfade
 * should just appear — it is not that complicated."*
 *
 * It was that complicated, because an overlap was **refused**. Every move clamped flush against its
 * neighbour, so the only route to a dissolve was the transition dialog: select two clips that already
 * meet exactly at a cut, name an effect, type a length, and hope both had handles. The gesture every
 * editor uses — drag one clip onto the one before it — did nothing at all.
 *
 * ## Why a fade is a clip property and a transition is not
 *
 * Sound **sums** and picture **occludes**, and a crossfade means something different in each. Two
 * overlapping sounds are both heard, so both need a ramp and the pair has to be equal-power or the
 * join dips. Two overlapping pictures are not both seen: the later one covers the earlier, so a
 * dissolve is the incoming clip ramping *in* over an outgoing one that stays whole. That asymmetry is
 * not an inconsistency to be papered over; it is the physics, and modelling it as one symmetric
 * object would make one of the two wrong.
 *
 * What that buys: the fades are on the clips, so they survive a save, a trim and an undo like
 * anything else, they are visible as ramps at the clip's edges, and a user who wants one without an
 * overlap simply drags a handle. The transition entity stays for what only it can do — a wipe, a
 * warp, anything with a shader between two pictures.
 */

/** A crossfade that placing a clip somewhere would produce. */
export interface CrossfadePlan {
  readonly track: TrackId;
  /** The clip already there, which the incoming one lands on top of. */
  readonly outgoing: ClipId;
  /** The clip being placed. */
  readonly incoming: ClipId;
  /** The overlapping region, in project frames. */
  readonly span: FrameSpan;
}

/**
 * The shortest overlap worth treating as a crossfade.
 *
 * Below this an overlap is a misdrop, not an intention, and turning every one-frame slip into a fade
 * would make it impossible to butt two clips together — which is the *other* half of the same report.
 */
export const MIN_CROSSFADE_FRAMES = 2;

/**
 * The crossfade that moving a clip to a position on a track would create, if any.
 *
 * Pure and separate from applying it, so a drag can ask the question every pointer move — to tint the
 * overlap and say what will happen — without touching the document.
 *
 * `undefined` for every case that is not unambiguously a crossfade, and each exclusion is a decision:
 *
 * - **Nothing overlapped.** An ordinary move.
 * - **More than one clip overlapped.** Which of them is the outgoing side has no answer, and guessing
 *   would silently pick one.
 * - **Either clip would be wholly covered.** That is not a dissolve, it is one shot replacing
 *   another, and the spec's rule against destroying material the user cannot see applies.
 * - **A text track.** Titles are composited above everything and never occlude each other, so an
 *   overlap there is two titles on screen at once — which is legal, and not a crossfade.
 */
export function crossfadeForPlacement(
  document: TimelineDocument,
  clip: ClipId,
  targetTrack: TrackId,
  span: FrameSpan,
): CrossfadePlan | undefined {
  const track = document.sequence.tracks.find((candidate) => candidate.id === targetTrack);
  if (track === undefined || track.locked) return undefined;
  if (track.kind === 'text') return undefined;

  /*
   * One pass, and it stops at the second clip it touches.
   *
   * This runs on **every pointer move of every drag** — a single-clip move has to come through here,
   * because dropping one clip onto another is how a crossfade is made — so a pair of `filter` calls
   * over the track was two arrays of a few hundred clips per move, on the path with a 16 ms budget.
   * Two touched clips is already an answer, so there is nothing to gain by looking at the rest.
   */
  let neighbour: Clip | undefined;
  for (const candidate of trackClips(track)) {
    if (candidate.id === clip) continue;
    if (candidate.span.start >= endExclusive(span) || span.start >= endExclusive(candidate.span)) continue;
    // A second one, and which of them is the outgoing side has no answer. Refuse rather than guess.
    if (neighbour !== undefined) return undefined;
    neighbour = candidate;
  }
  if (neighbour === undefined) return undefined;

  const overlap = intersection(neighbour.span, span);
  if (overlap === undefined) return undefined;
  if (overlap.duration < MIN_CROSSFADE_FRAMES) return undefined;

  // Neither may be swallowed. `<` rather than `<=` on purpose: an overlap exactly as long as a clip
  // covers it completely, which is a replacement and not a fade.
  if (overlap.duration >= neighbour.span.duration || overlap.duration >= span.duration) return undefined;

  // Whichever starts later is the one arriving, in both domains. For sound the label only decides
  // which ramp is drawn where; for picture it decides which frame is on top.
  const incomingIsPlaced = span.start >= neighbour.span.start;

  return {
    track: track.id,
    outgoing: incomingIsPlaced ? neighbour.id : clip,
    incoming: incomingIsPlaced ? clip : neighbour.id,
    span: overlap,
  };
}

/**
 * Writes the ramps a crossfade needs.
 *
 * The asymmetry is the whole point, and it is decided by the **track**, not by the clip: what matters
 * is whether the two signals sum or occlude, and that is a property of the medium.
 *
 * - **Audio** — both sides ramp, over the full overlap. They are summed, so a fade on one alone would
 *   leave the other at full level under it and the join would be *louder* than either clip.
 * - **Video** — only the incoming ramps. The outgoing is underneath and whole; fading it too would
 *   let the empty frame behind them show through in the middle of the dissolve, which reads as a
 *   flash of black exactly where the join is meant to be invisible.
 *
 * Ramps are **replaced, not accumulated**. Dragging further along an overlap re-applies this with a
 * longer span, and adding to what is already there would make a fade grow with every pointer move.
 */
export function applyCrossfade(
  document: TimelineDocument,
  plan: CrossfadePlan,
): Result<TimelineDocument, EditError> {
  const track = document.sequence.tracks.find((candidate) => candidate.id === plan.track);
  if (track === undefined) return err({ kind: 'track-not-found', track: plan.track });

  const unlocked = assertUnlocked(track);
  if (!unlocked.ok) return unlocked;

  const frames = plan.span.duration;
  const withIncoming = setClipFade(document, plan.incoming, { inFrames: frames });
  if (!withIncoming.ok) return withIncoming;
  if (track.kind !== 'audio') return withIncoming;

  return setClipFade(withIncoming.value, plan.outgoing, { outFrames: frames });
}

/** One or both ends of a clip's ramp. An omitted end is left as it was. */
export type FadeChange = Partial<ClipFade>;

/**
 * Sets a clip's edge ramps.
 *
 * Clamped to the clip's own length rather than refused: a ramp longer than the clip renders
 * identically to one exactly as long as it, and rejecting a drag that ran a little too far would stop
 * the gesture at a limit nothing on screen marks.
 *
 * A ramp of zero at both ends **removes** the field rather than storing zeroes, so a clip with no
 * fade serializes and compares exactly as it did before fades existed.
 */
export function setClipFade(
  document: TimelineDocument,
  clipId: ClipId,
  change: FadeChange,
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;
  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;

  const { track, clip } = located.value;
  const current = clipFade(clip);
  const limit = clip.span.duration;
  const next: ClipFade = {
    inFrames: clampFade(change.inFrames ?? current.inFrames, limit),
    outFrames: clampFade(change.outFrames ?? current.outFrames, limit),
  };

  if (next.inFrames === current.inFrames && next.outFrames === current.outFrames) return ok(document);

  return ok(replaceTrack(document, replaceClip(track, withFade(clip, next))));
}

/** Removes both ramps. */
export function clearClipFade(
  document: TimelineDocument,
  clipId: ClipId,
): Result<TimelineDocument, EditError> {
  return setClipFade(document, clipId, { inFrames: 0, outFrames: 0 });
}

/**
 * The longest ramp a clip could carry at one of its edges.
 *
 * Its own length, minus nothing: a clip that fades for its whole duration is a legitimate thing to
 * ask for, and it is what dropping a clip almost entirely onto another produces.
 */
export function maxFadeFrames(clip: Clip): number {
  return clip.span.duration;
}

function clampFade(frames: number, limit: number): number {
  if (!Number.isFinite(frames)) return 0;
  return Math.min(limit, Math.max(0, Math.round(frames)));
}

function withFade(clip: Clip, fade: ClipFade): Clip {
  if (fade.inFrames === 0 && fade.outFrames === 0) {
    const { fade: _dropped, ...rest } = clip;
    return rest as Clip;
  }
  return { ...clip, fade } as Clip;
}
