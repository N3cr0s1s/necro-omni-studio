import {
  type Clip,
  type ClipId,
  type Result,
  type TimelineDocument,
  type TrackId,
  endExclusive,
  err,
  locateClip,
  ok,
  trackClips,
} from '@nos/core';
import { eligibleTracksFor } from './drag-target.js';
import type { EditError } from './errors.js';
import { moveClipsBy } from './move-many.js';
import { withLinkedClips } from './selection.js';

/**
 * Closing the gap before a clip.
 *
 * The third of issue #38's complaints, and the one that reads as the smallest: *"I put two videos next
 * to each other and there is one frame of blackness, because for some reason I cannot place them
 * exactly next to each other."*
 *
 * Snapping stops it happening again. This is for the gaps that already exist — after a trim, after a
 * delete, after an import — where the answer is not "drag more carefully" but "put it where it
 * obviously goes". A frame of black is invisible at any zoom a person works at and unmistakable in the
 * delivered file, which is the worst combination a defect can have.
 *
 * **Left, never right.** The clip moves back to meet its neighbour; the neighbour is not stretched
 * forward. Growing a clip changes what plays, and a command named for removing a gap must not quietly
 * add six frames of material nobody asked to see.
 *
 * **The whole group travels**, so a linked pair stays a pair — and all or nothing, because a picture
 * that closed its gap while its sound stayed put is exactly the desynchronization the linked trim
 * exists to prevent.
 */

/** The gap before a clip, and what closing it would take. */
export interface GapBefore {
  readonly track: TrackId;
  /** The clip on the far side of the gap. Absent when the gap is the start of the timeline. */
  readonly previous?: ClipId;
  /** How many frames of nothing lie between them. Always positive. */
  readonly frames: number;
}

/**
 * The gap immediately before a clip, if there is one.
 *
 * `undefined` when the clip is already flush against its neighbour, when it overlaps one — an overlap
 * is a crossfade, not a gap — or when nothing precedes it and it already starts at frame zero.
 *
 * Separate from the operation so a menu can offer the row only when it would do something, and say how
 * many frames it would close. A row that is offered and then refuses teaches the user to distrust the
 * menu.
 */
export function gapBefore(document: TimelineDocument, clip: ClipId): GapBefore | undefined {
  const located = locateClip(document, clip);
  if (located === undefined || located.track.locked) return undefined;

  const start = located.clip.span.start;
  let nearestEnd = 0;
  let previous: Clip | undefined;

  for (const candidate of trackClips(located.track)) {
    if (candidate.id === clip) continue;
    if (candidate.span.start >= start) continue;

    // Clipped at this clip's own start rather than skipped when it runs past it. A neighbour that
    // *overlaps* occupies the frame before, so the gap is zero — skipping it instead would look past a
    // clip that is plainly there and report the distance back to whatever lies before *that*, which
    // on a track with one overlapping pair is the whole distance to frame zero.
    const reach = Math.min(endExclusive(candidate.span), start);
    if (reach >= nearestEnd) {
      nearestEnd = reach;
      previous = candidate;
    }
  }

  const frames = start - nearestEnd;
  if (frames <= 0) return undefined;

  return {
    track: located.track.id,
    ...(previous === undefined ? {} : { previous: previous.id }),
    frames,
  };
}

/**
 * Moves a clip back until it meets what precedes it.
 *
 * A no-op when there is no gap, rather than an error: the command is idempotent, which is what makes
 * it safe to bind to a key and press twice.
 */
export function closeGapBefore(
  document: TimelineDocument,
  clip: ClipId,
): Result<TimelineDocument, EditError> {
  const gap = gapBefore(document, clip);
  if (gap === undefined) return ok(document);

  const group = withLinkedClips(document, [clip]);
  const moved = moveClipsBy(document, group, -gap.frames, 0, (member) =>
    eligibleTracksFor(document.sequence.tracks, member),
  );
  if (!moved.ok) return moved;

  // `moveClips` clamps at frame zero and reports how far it actually went. A partial close is still a
  // smaller gap, but saying nothing moved when something did would be a lie, and reporting it as
  // failure would refuse an edit that succeeded.
  return ok(moved.value.document);
}

/** Every clip on a track that a gap precedes, so a whole track can be closed up in one pass. */
export function closeAllGaps(
  document: TimelineDocument,
  track: TrackId,
): Result<TimelineDocument, EditError> {
  const found = document.sequence.tracks.find((candidate) => candidate.id === track);
  if (found === undefined) return err({ kind: 'track-not-found', track });
  if (found.locked) return err({ kind: 'track-locked', track });

  // Left to right, and re-read after each move: closing one gap changes where the next clip's
  // neighbour ends, so a list computed once would close the second gap to a position that no longer
  // exists.
  let current = document;
  const order = [...trackClips(found)].sort((a, b) => a.span.start - b.span.start).map((clip) => clip.id);

  for (const clip of order) {
    const closed = closeGapBefore(current, clip);
    // A clip that cannot move — its linked partner is blocked on another track — is stepped over
    // rather than failing the pass. Closing four of five gaps is worth more than closing none.
    if (closed.ok) current = closed.value;
  }

  return ok(current);
}
