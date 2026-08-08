import {
  type Clip,
  type ClipId,
  type Result,
  type TimelineDocument,
  type Track,
  type TrackId,
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
 * Translates a set of clips *and* shifts each by a number of rows.
 *
 * The case that made vertical movement useless even once it existed: an imported video and its audio
 * are linked, so grabbing either one drags both — and a two-clip drag was deliberately kept on its
 * tracks, because "which row should each of a mixed selection land on" has no single answer.
 *
 * It does have one, and this is it: **the same row delta, applied within each clip's own kind**. A
 * video moves down one video track and its audio down one audio track; neither can land on a row that
 * cannot hold it, so the pair stays a pair and nothing has to be guessed. A selection spanning kinds
 * keeps its shape for the same reason.
 *
 * All or nothing, like `moveClips`: a partial move breaks exactly the alignment the user preserved by
 * moving them together. Rows that do not exist clamp rather than refuse — running out of tracks
 * should stop the vertical part of a drag, not cancel it.
 */
export function moveClipsBy(
  document: TimelineDocument,
  ids: readonly ClipId[],
  deltaFrames: number,
  deltaRows: number,
  eligibleTracks: (clip: Clip) => readonly TrackId[],
): Result<MoveManyResult, EditError> {
  if (deltaRows === 0) return moveClips(document, ids, deltaFrames);

  const moving = new Set<string>(ids as readonly string[]);
  if (moving.size === 0) return ok({ document, deltaFrames: 0 });

  // Time first, on the existing tracks, so the horizontal part keeps the behaviour it already had —
  // including the clamp at frame zero and the all-or-nothing collision rule.
  const shifted = moveClips(document, ids, deltaFrames);
  if (!shifted.ok) return shifted;

  interface Pending {
    readonly clip: Clip;
    readonly from: TrackId;
    readonly to: TrackId;
  }

  const pending: Pending[] = [];
  for (const track of shifted.value.document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      if (!moving.has(clip.id)) continue;
      const eligible = eligibleTracks(clip);
      const at = eligible.indexOf(track.id);
      if (at < 0) continue;
      const index = Math.min(eligible.length - 1, Math.max(0, at + deltaRows));
      const to = eligible[index];
      if (to !== undefined && to !== track.id) pending.push({ clip, from: track.id, to });
    }
  }

  if (pending.length === 0) return shifted;

  // Removed from every source before being added to any destination, so a swap between two rows is
  // possible and a clip never collides with the version of itself it is replacing.
  let tracks = shifted.value.document.sequence.tracks.map((track) => {
    const leaving = pending.filter((move) => move.from === track.id);
    if (leaving.length === 0) return track;
    const unlocked = assertUnlocked(track);
    if (!unlocked.ok) return track;
    return withClips(
      track,
      trackClips(track).filter((clip) => !leaving.some((move) => move.clip.id === clip.id)),
    );
  });

  for (const move of pending) {
    const index = tracks.findIndex((track) => track.id === move.to);
    const target = tracks[index];
    if (target === undefined) return err({ kind: 'track-not-found', track: move.to });

    const unlocked = assertUnlocked(target);
    if (!unlocked.ok) return unlocked;

    const combined = [...trackClips(target), move.clip].sort((a, b) => a.span.start - b.span.start);
    const blocker = firstOverlap(combined, new Set<string>([move.clip.id]));
    if (blocker !== undefined) {
      return err({ kind: 'collision', track: move.to, withClip: blocker });
    }

    tracks = tracks.map((track, at) => (at === index ? withClips(track, combined) : track));
  }

  return ok({
    document: { ...shifted.value.document, sequence: { ...shifted.value.document.sequence, tracks } },
    deltaFrames: shifted.value.deltaFrames,
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
