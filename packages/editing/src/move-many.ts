import {
  type Clip,
  type ClipId,
  type Result,
  type TimelineDocument,
  type Track,
  err,
  frameIndex,
  ok,
  spanFromBounds,
  trackClips,
} from '@nos/core';
import type { EditError } from './errors.js';
import { assertUnlocked, withClips } from './mutate.js';

/**
 * Moving several clips at once.
 *
 * Dragging one clip of a selection had moved only that clip, which quietly undoes the point of having
 * a selection: a user who marqueed a scene and dragged it would find one clip moved and the rest of
 * the scene left behind — the worst possible outcome, because it looks like it worked.
 *
 * Not a loop over `moveClip`. Applying moves one at a time makes each collide with the clips that
 * have not moved yet: shifting a run of adjacent clips right by ten frames would refuse at the first
 * one, because its neighbour is still where it was. The whole set has to be considered together, and
 * that is the entire reason this exists as its own operation.
 */

export interface MoveManyResult {
  readonly document: TimelineDocument;
  /** How far they actually moved, which is the requested delta or nothing. */
  readonly deltaFrames: number;
}

/**
 * Translates a set of clips along their own tracks.
 *
 * All or nothing: if any clip in the set would land on something outside it, the whole move is
 * refused. A partial move would break exactly the alignment the user was preserving by moving them
 * together.
 *
 * Clamped at the start of the timeline rather than refused there — a drag that runs into frame zero
 * should stop, which is what every editor does, not snap back to where it began.
 */
export function moveClips(
  document: TimelineDocument,
  ids: readonly ClipId[],
  deltaFrames: number,
): Result<MoveManyResult, EditError> {
  const moving = new Set<string>(ids as readonly string[]);
  if (moving.size === 0 || deltaFrames === 0) return ok({ document, deltaFrames: 0 });

  // The furthest left any of them may go before one would pass frame zero. Applied to the whole set
  // so they keep their spacing as the group meets the start of the timeline.
  let earliest = Number.POSITIVE_INFINITY;
  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      if (moving.has(clip.id)) earliest = Math.min(earliest, clip.span.start);
    }
  }
  if (!Number.isFinite(earliest)) return err({ kind: 'clip-not-found', clip: ids[0]! });

  const delta = Math.max(deltaFrames, -earliest);
  if (delta === 0) return ok({ document, deltaFrames: 0 });

  const tracks: Track[] = [];
  for (const track of document.sequence.tracks) {
    const mine = trackClips(track).filter((clip) => moving.has(clip.id));
    if (mine.length === 0) {
      tracks.push(track);
      continue;
    }

    const unlocked = assertUnlocked(track);
    if (!unlocked.ok) return unlocked;

    const shifted = trackClips(track).map((clip) =>
      moving.has(clip.id)
        ? ({
            ...clip,
            span: spanFromBounds(
              frameIndex(clip.span.start + delta),
              frameIndex(clip.span.start + delta + clip.span.duration),
            ),
          } as Clip)
        : clip,
    );

    // Checked once, after every clip in the set has been shifted — which is what makes moving a run
    // of adjacent clips possible at all.
    const blocker = firstOverlap(shifted, moving);
    if (blocker !== undefined) {
      return err({ kind: 'collision', track: track.id, withClip: blocker });
    }

    tracks.push(withClips(track, shifted));
  }

  return ok({
    document: { ...document, sequence: { ...document.sequence, tracks } },
    deltaFrames: delta,
  });
}

/**
 * The first clip a moved one lands on.
 *
 * Only pairs with **exactly one** side moving are checked, and that is exact rather than a
 * convenience. A translation preserves relative positions, so two clips that are both in the set
 * overlap after the move if and only if they overlapped before it — reporting them would blame this
 * move for a state the document was already in, and leave a selection unable to escape a mess it did
 * not create. Pairs with neither side moving are, for the same reason, none of this operation's
 * business.
 */
function firstOverlap(clips: readonly Clip[], moving: ReadonlySet<string>): ClipId | undefined {
  for (let index = 0; index < clips.length; index += 1) {
    const left = clips[index]!;
    for (let other = index + 1; other < clips.length; other += 1) {
      const right = clips[other]!;
      if (moving.has(left.id) === moving.has(right.id)) continue;
      if (overlaps(left, right)) return moving.has(left.id) ? right.id : left.id;
    }
  }
  return undefined;
}

function overlaps(left: Clip, right: Clip): boolean {
  return (
    left.span.start < right.span.start + right.span.duration &&
    right.span.start < left.span.start + left.span.duration
  );
}
