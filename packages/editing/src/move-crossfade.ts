import {
  type Clip,
  type ClipId,
  type Result,
  type TimelineDocument,
  type TrackId,
  frameIndex,
  ok,
  spanFromBounds,
  trackClips,
} from '@nos/core';
import type { EditError } from './errors.js';
import { type CrossfadePlan, applyCrossfade, crossfadeForPlacement } from './fade-ops.js';
import { moveClipsBy } from './move-many.js';

/**
 * Dropping a clip onto its neighbour, which is how a crossfade is actually made.
 *
 * The composite the report asked for: *"if I lay two videos or two sounds over each other, a
 * crossfade should appear there — it is not that complicated."* It is not, but it needed three
 * separate things to agree. The move has to be **permitted** to overlap, and only with the clip the
 * user is dropping onto. The overlap has to be recognized as a crossfade rather than as a mistake.
 * And the ramps have to be written in the same transaction, or an undo would leave the clips
 * overlapping with nothing to show for it.
 *
 * Kept out of the drag hook because every part of it is a question about the document — which clip is
 * arriving, whether the overlap swallows anything, what a track's medium implies — and none of it is
 * about pixels. The hook decides *whether* to ask.
 */

export interface CrossfadeMoveRequest {
  readonly document: TimelineDocument;
  /** Everything travelling together: the grabbed clip, its selection, and whatever is linked. */
  readonly ids: readonly ClipId[];
  readonly deltaFrames: number;
  readonly deltaRows: number;
  readonly eligibleTracks: (clip: Clip) => readonly TrackId[];
}

export interface CrossfadeMoveResult {
  readonly document: TimelineDocument;
  readonly deltaFrames: number;
  /**
   * The crossfades this move created, so the UI can say what happened.
   *
   * Plural because a linked video and its audio dropped onto another linked pair make two — one per
   * medium — and a user told "a crossfade was created" when two were is being told something false
   * about their own timeline.
   */
  readonly crossfades: readonly CrossfadePlan[];
}

/**
 * Moves a group, turning any overlap it lands in into a crossfade.
 *
 * Refuses exactly what an ordinary move refuses. An overlap that `crossfadeForPlacement` does not
 * recognize — two clips at once, one clip swallowed, a locked or text track — is still a collision,
 * and the caller clamps against it as it always did. That is deliberate: the permission granted here
 * is narrow and named, so the timeline's rule that material is never displaced silently still holds
 * everywhere else.
 */
export function moveWithCrossfades(request: CrossfadeMoveRequest): Result<CrossfadeMoveResult, EditError> {
  const { document, ids, deltaFrames, deltaRows, eligibleTracks } = request;

  const plans = plannedCrossfades(request);
  const moving = new Set<string>(ids as readonly string[]);

  // The clips the move may land on: the stationary half of each planned pair. Not `outgoing`, which
  // is whichever starts later and is therefore the *moving* clip whenever one is dropped just before
  // a shot rather than just after it.
  const permitted = new Set<string>();
  for (const plan of plans) {
    if (!moving.has(plan.outgoing)) permitted.add(plan.outgoing);
    if (!moving.has(plan.incoming)) permitted.add(plan.incoming);
  }

  const moved = moveClipsBy(document, ids, deltaFrames, deltaRows, eligibleTracks, { permitted });
  if (!moved.ok) return moved;

  // Nothing overlapped: an ordinary move, and saying so with an empty list rather than a separate
  // shape keeps one return type for the caller to handle.
  if (plans.length === 0) {
    return ok({ document: moved.value.document, deltaFrames: moved.value.deltaFrames, crossfades: [] });
  }

  // Re-planned against the moved document. The first pass predicted where the clips would land; this
  // one reads where they actually did, and the two differ whenever the move was clamped at frame
  // zero — writing the predicted ramp there would fade over frames the clip no longer covers.
  const landed = plannedCrossfades(
    { ...request, deltaFrames: moved.value.deltaFrames },
    moved.value.document,
  );

  let current = moved.value.document;
  for (const plan of landed) {
    const faded = applyCrossfade(current, plan);
    if (!faded.ok) return faded;
    current = faded.value;
  }

  return ok({ document: current, deltaFrames: moved.value.deltaFrames, crossfades: landed });
}

/**
 * The crossfades a move would create, without applying anything.
 *
 * Two callers, one derivation: the move above, and a drag wanting to show the overlap before the
 * pointer is released. A second implementation of "where will these land" is how a preview and its
 * commit end up disagreeing.
 *
 * `landedIn` is the document the clips are already in, used when re-reading an applied move. Omitted,
 * the placement is predicted from the request's own deltas.
 */
export function plannedCrossfades(
  request: CrossfadeMoveRequest,
  landedIn?: TimelineDocument,
): readonly CrossfadePlan[] {
  const { document, ids, deltaFrames, deltaRows, eligibleTracks } = request;
  const moving = new Set<string>(ids as readonly string[]);
  const plans: CrossfadePlan[] = [];

  // Walked in whichever document the clips are being read from. Reading their spans out of the
  // *original* while searching the moved one is how the re-plan came back empty: every predicted
  // overlap was computed against positions the clips had already left.
  const search = landedIn ?? document;
  void document;

  for (const track of search.sequence.tracks) {
    for (const clip of trackClips(track)) {
      if (!moving.has(clip.id)) continue;

      const destination =
        landedIn === undefined ? rowAfter(clip, track.id, deltaRows, eligibleTracks) : track.id;
      const start = landedIn === undefined ? clip.span.start + deltaFrames : clip.span.start;
      if (start < 0) continue;

      const span = spanFromBounds(frameIndex(start), frameIndex(start + clip.span.duration));
      const plan = crossfadeForPlacement(search, clip.id, destination, span);
      if (plan === undefined) continue;

      // A clip landing on another clip that is *also* moving is the group closing up on itself, not a
      // crossfade — a translation preserves spacing, so the two overlapped before the drag too.
      //
      // Tested on the *neighbour* rather than on the outgoing side. Which of the pair is outgoing
      // depends on which starts later, so a clip dropped just *before* a stationary one is itself the
      // outgoing half — and reading `outgoing` here discarded exactly the dissolves made by dragging
      // a clip leftwards onto the shot in front of it.
      const neighbour = plan.outgoing === clip.id ? plan.incoming : plan.outgoing;
      if (moving.has(neighbour)) continue;

      plans.push(plan);
    }
  }

  return plans;
}

/** The row a clip ends on, applying the group's row delta within its own kind. */
function rowAfter(
  clip: Clip,
  from: TrackId,
  deltaRows: number,
  eligibleTracks: (clip: Clip) => readonly TrackId[],
): TrackId {
  if (deltaRows === 0) return from;
  const eligible = eligibleTracks(clip);
  const at = eligible.indexOf(from);
  if (at < 0) return from;
  const index = Math.min(eligible.length - 1, Math.max(0, at + deltaRows));
  return eligible[index] ?? from;
}
