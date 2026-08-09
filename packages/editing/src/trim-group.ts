import { type ClipId, type Result, type TimelineDocument, err, ok } from '@nos/core';
import { type EditOptions, trimClipEnd, trimClipStart } from './clip-ops.js';
import type { EditError } from './errors.js';
import { withLinkedClips } from './selection.js';

/**
 * Trimming everything that has to be trimmed together.
 *
 * A drag on a linked pair moved both halves from the day linking landed, and a *trim* on one moved
 * only the half under the pointer — so the most ordinary edit there is, cutting the head off an
 * imported clip, silently desynchronized the picture from its own sound. The report was exactly that:
 * "either only the audio's length changes, or only the video's".
 *
 * The fix is not a special case inside `trimClipStart`. That operation is about one clip and has to
 * stay that way, for the same reason `moveClip` did: the set that travels together is a question about
 * *selection*, which the document layer does not answer. This is the composite, in the same shape as
 * `moveClips` — one gesture, one refusal, one undo step.
 */

/** Which edge of a clip a trim moves. */
export type TrimEdge = 'start' | 'end';

export interface GroupTrimRequest {
  readonly document: TimelineDocument;
  /** The clip the pointer is on. Whatever is linked to it comes along. */
  readonly clip: ClipId;
  readonly edge: TrimEdge;
  /** Positive shortens a head trim and lengthens a tail trim, as on the single-clip operations. */
  readonly delta: number;
  readonly options?: EditOptions;
}

/**
 * Trims a clip and everything linked to it by the same number of project frames.
 *
 * **The same delta, not the same frame.** A pair that was flush stays flush, and a pair the user
 * deliberately offset keeps its offset — reading one clip's new edge and writing it onto the other
 * would quietly undo an offset that was authored on purpose.
 *
 * **All or nothing.** If either half refuses — the sound has handles the picture does not, a
 * neighbour is in the way on one track only — the whole trim refuses and the pair stays in step. A
 * partial trim is the bug this exists to prevent, not a graceful degradation of it.
 *
 * A clip with nothing linked to it goes through the ordinary single-clip path, so there is one
 * behaviour to reason about rather than two.
 */
export function trimGroup(request: GroupTrimRequest): Result<TimelineDocument, EditError> {
  const { document, clip, edge, delta, options } = request;
  if (delta === 0) return ok(document);

  const group = withLinkedClips(document, [clip]);
  if (group.length === 0) return err({ kind: 'clip-not-found', clip });

  let current = document;
  for (const member of group) {
    const trimmed =
      edge === 'start'
        ? trimClipStart(current, member, delta)
        : trimClipEnd(current, member, delta, options ?? {});
    if (!trimmed.ok) return trimmed;
    current = trimmed.value;
  }

  return ok(current);
}

/**
 * How far a trim may travel before one member of the group refuses.
 *
 * The same rule a blocked move follows — go as far as possible, never nothing — applied to an edge.
 * Without it a linked pair is *harder* to trim than a lone clip: the audio running two frames longer
 * than the picture would refuse the whole gesture at the point where the picture still had room, and
 * the clip would snap back to where it started.
 *
 * A binary search rather than a formula, because "how far can this go" is the composition of every
 * check the two trims perform — collisions, source handles, locks, emptiness — and restating those
 * here is how the limit and the operation drift apart.
 */
export function reachableTrimDelta(request: GroupTrimRequest): number {
  const { delta } = request;
  if (delta === 0) return 0;
  if (trimGroup(request).ok) return delta;

  const sign = Math.sign(delta);
  let feasible = 0;
  let infeasible = Math.abs(delta);

  // At most ~31 probes for any delta a drag can produce, and each is a pure document transform.
  while (infeasible - feasible > 1) {
    const midpoint = Math.floor((feasible + infeasible) / 2);
    if (trimGroup({ ...request, delta: midpoint * sign }).ok) {
      feasible = midpoint;
    } else {
      infeasible = midpoint;
    }
  }

  return feasible * sign;
}
