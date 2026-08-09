import {
  type Clip,
  type ClipId,
  type FrameRate,
  type Result,
  type TimelineDocument,
  clipFade,
  endExclusive,
  err,
  frameIndex,
  frameRateToNumber,
  locateClip,
  ok,
  spanFromBounds,
} from '@nos/core';
import { type EditOptions, UNBOUNDED_SOURCES } from './clip-ops.js';
import type { EditError } from './errors.js';
import { MIN_CROSSFADE_FRAMES } from './fade-ops.js';
import { replaceClip, replaceTrack } from './mutate.js';
import { clipAfter, clipBefore } from './roll-edit.js';

/**
 * A crossfade made at a cut, out of the material either side of it.
 *
 * The other half of issue #38's crossfade, and the half a keyboard reaches. Dropping one clip onto
 * another is the gesture, and it makes the sequence **shorter** by exactly the overlap — which is
 * right when you are closing a gap in the cut and wrong when the cut is already timed. This one keeps
 * the length: the outgoing clip grows forward past the cut and the incoming one starts earlier, each
 * by half the fade, out of the material that was already there beyond their edges.
 *
 * That is the same mechanic `addTransition` uses, and the reason it is not simply reused: transitions
 * live on video tracks. A pair of sounds meeting at a cut had **no way at all** to be crossfaded
 * except by dragging one over the other and shortening the sequence — which is the complaint, stated
 * about audio.
 *
 * **Handles are the whole difficulty.** A clip with nothing beyond its out-point cannot be extended,
 * and a fade made anyway would hold its last frame — a freeze in the middle of a dissolve, which
 * looks like a bug in the renderer. So the refusal names how many frames are missing and from which
 * clip, and the caller can offer a shorter one.
 */

export interface CutCrossfadeRequest {
  readonly document: TimelineDocument;
  /**
   * Either clip of the pair.
   *
   * Named as one rather than two because that is what a selection is: the user has clicked a clip and
   * asked for a crossfade, and which side of it the cut lies on is a question about the document.
   */
  readonly clip: ClipId;
  /** Which cut, when the clip has one on both sides. */
  readonly side?: 'before' | 'after';
  /** Total overlap, split evenly across the cut. */
  readonly frames: number;
  readonly options?: EditOptions;
}

/** The pair a crossfade would join, and which side of the given clip it sits on. */
export interface CutPair {
  readonly outgoing: ClipId;
  readonly incoming: ClipId;
}

/**
 * The cut a crossfade would be made at, from one clip and a preferred side.
 *
 * `after` by default, because a clip's own out-point is the cut a user means when they select it and
 * ask for a dissolve — reading left is the exception, and it is asked for explicitly.
 *
 * Separate from the operation so a menu can offer the row only when there is a cut, and so the row
 * and the action cannot disagree about which pair they are about.
 */
export function cutPairFor(
  document: TimelineDocument,
  clip: ClipId,
  side: 'before' | 'after' = 'after',
): CutPair | undefined {
  if (side === 'before') {
    const previous = clipBefore(document, clip);
    return previous === undefined ? undefined : { outgoing: previous, incoming: clip };
  }
  const next = clipAfter(document, clip);
  return next === undefined ? undefined : { outgoing: clip, incoming: next };
}

/**
 * Makes a crossfade at a cut, consuming the handles either side of it.
 *
 * All or nothing: if either clip cannot supply its half, nothing moves. A crossfade with one side
 * extended is a clip that has silently grown, and the user asked for a dissolve rather than for more
 * material.
 */
export function crossfadeAtCut(request: CutCrossfadeRequest): Result<TimelineDocument, EditError> {
  const { document, clip, frames, options } = request;
  const pair = cutPairFor(document, clip, request.side ?? 'after');
  if (pair === undefined) return err({ kind: 'no-shared-cut', clips: [clip, clip] });

  const left = locateClip(document, pair.outgoing);
  const right = locateClip(document, pair.incoming);
  if (left === undefined) return err({ kind: 'clip-not-found', clip: pair.outgoing });
  if (right === undefined) return err({ kind: 'clip-not-found', clip: pair.incoming });
  if (left.track.locked) return err({ kind: 'track-locked', track: left.track.id });
  if (left.track.id !== right.track.id)
    return err({ kind: 'no-shared-cut', clips: [pair.outgoing, pair.incoming] });
  if (endExclusive(left.clip.span) !== right.clip.span.start) {
    return err({ kind: 'no-shared-cut', clips: [pair.outgoing, pair.incoming] });
  }

  const total = Math.round(frames);
  if (total < MIN_CROSSFADE_FRAMES) return err({ kind: 'empty-result', clip: pair.incoming });

  // Neither clip may be wholly consumed: a fade longer than the material it joins is a dissolve
  // between two things the viewer never sees.
  if (total >= left.clip.span.duration || total >= right.clip.span.duration) {
    return err({ kind: 'empty-result', clip: pair.incoming });
  }

  const before = Math.floor(total / 2);
  const after = total - before;

  const grown = growEnd(left.clip, after, options ?? {});
  if (!grown.ok) return grown;
  const pulled = pullStart(right.clip, before, options ?? {});
  if (!pulled.ok) return pulled;

  // The ramps, written over the overlap the two extensions just made. Sound sums and picture
  // occludes, so the asymmetry is the same one `applyCrossfade` states: both sides ramp on an audio
  // track, only the arriving one on a video track.
  const audio = left.track.kind === 'audio';
  const outgoing = withFade(grown.value, {
    ...clipFade(grown.value),
    ...(audio ? { outFrames: total } : {}),
  });
  const incoming = withFade(pulled.value, { ...clipFade(pulled.value), inFrames: total });

  const withOutgoing = replaceTrack(document, replaceClip(left.track, outgoing));
  const track = withOutgoing.sequence.tracks.find((entry) => entry.id === left.track.id);
  if (track === undefined) return err({ kind: 'track-not-found', track: left.track.id });

  return ok(replaceTrack(withOutgoing, replaceClip(track, incoming)));
}

/**
 * The longest crossfade a cut could carry, given what the sources hold.
 *
 * So a caller can offer a shorter one rather than only a refusal — "there is not enough material" is
 * true and unhelpful next to "six frames is all this cut has". Zero when the cut cannot carry one at
 * all.
 */
export function maxCrossfadeAtCut(
  document: TimelineDocument,
  clip: ClipId,
  side: 'before' | 'after' = 'after',
  options: EditOptions = {},
): number {
  const pair = cutPairFor(document, clip, side);
  if (pair === undefined) return 0;

  const left = locateClip(document, pair.outgoing);
  const right = locateClip(document, pair.incoming);
  if (left === undefined || right === undefined) return 0;

  // Half from each side, so the limit is twice the scarcer half — and never more than the shorter
  // clip, which the operation refuses to consume whole.
  const tail = handleAfter(left.clip, options);
  const head = handleBefore(right.clip);
  const byHandles = Math.min(tail, head) * 2;
  const byLength = Math.min(left.clip.span.duration, right.clip.span.duration) - 1;

  return Math.max(0, Math.min(byHandles, byLength));
}

/** Frames of material beyond a clip's out-point, or infinity when nothing knows. */
function handleAfter(clip: Clip, options: EditOptions): number {
  if (clip.kind === 'text' || clip.kind === 'image') return Number.POSITIVE_INFINITY;
  const bounds = options.sources?.boundsFor(clip);
  if (bounds === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, bounds.totalFrames - clip.source.sourceIn - clip.span.duration);
}

/** Frames of material before a clip's in-point. Known from the document alone. */
function handleBefore(clip: Clip): number {
  if (clip.kind === 'text' || clip.kind === 'image') return Number.POSITIVE_INFINITY;
  return clip.source.sourceIn;
}

function growEnd(clip: Clip, frames: number, options: EditOptions): Result<Clip, EditError> {
  if (frames === 0) return ok(clip);

  const available = handleAfter(clip, options);
  if (available < frames) {
    return err({ kind: 'source-exhausted', clip: clip.id, available, requested: frames });
  }
  return ok({
    ...clip,
    span: spanFromBounds(clip.span.start, frameIndex(endExclusive(clip.span) + frames)),
  } as Clip);
}

function pullStart(clip: Clip, frames: number, options: EditOptions): Result<Clip, EditError> {
  void options;
  if (frames === 0) return ok(clip);

  const available = handleBefore(clip);
  if (available < frames) {
    return err({ kind: 'source-exhausted', clip: clip.id, available, requested: frames });
  }
  if (clip.span.start - frames < 0) {
    return err({ kind: 'source-exhausted', clip: clip.id, available: clip.span.start, requested: frames });
  }

  return ok({
    ...clip,
    span: spanFromBounds(frameIndex(clip.span.start - frames), endExclusive(clip.span)),
    /*
     * A still and a title keep their source position; only a moving picture has one to move.
     *
     * `handleBefore` answers infinity for both — correctly, because a frame held longer is exactly
     * what the viewer sees either way — and decrementing `sourceIn` on the strength of that put an
     * image at frame −6 of a file with one frame in it. Every reader downstream then clamps or
     * rounds it differently, which is the kind of wrong number that shows up as a blank frame three
     * layers away from the edit that caused it.
     */
    ...(clip.kind === 'text' || clip.kind === 'image'
      ? {}
      : { source: { ...clip.source, sourceIn: frameIndex(clip.source.sourceIn - frames) } }),
  } as Clip);
}

function withFade(clip: Clip, fade: ReturnType<typeof clipFade>): Clip {
  if (fade.inFrames === 0 && fade.outFrames === 0) {
    const { fade: _dropped, ...rest } = clip;
    return rest as Clip;
  }
  return { ...clip, fade } as Clip;
}

/**
 * The crossfade a command should offer when nobody has said how long.
 *
 * Half a second, at the project's own rate rather than a fixed frame count: twelve frames is a
 * comfortable dissolve at 24 fps and a blink at 60. Never below the minimum, so the default is always
 * a fade rather than a cut with extra machinery.
 */
export function defaultCrossfadeFrames(rate: FrameRate): number {
  return Math.max(MIN_CROSSFADE_FRAMES, Math.round(frameRateToNumber(rate) / 2));
}

/** Re-exported so a caller can state a default without importing the fade module too. */
export { UNBOUNDED_SOURCES };
