import type { ClipId, Result, TimelineDocument, TrackId } from '@nos/core';
import { endExclusive, frameIndex, locateClip, trackClips } from '@nos/core';
import type { EditError } from './errors.js';
import { trimClipEnd, trimClipStart } from './clip-ops.js';
import type { SourceBoundsResolver } from './clip-ops.js';

/**
 * Moving the cut between two adjacent clips.
 *
 * The one core edit the application did not have. Trimming either side of a cut leaves a gap or an
 * overlap; a **roll** moves the boundary itself, so one clip gains exactly what the other gives up
 * and the sequence's length never changes. It is what an editor reaches for constantly — the cut is
 * a frame late, so you move the cut — and without it the only way to adjust one was to trim twice
 * and hope the two ended up flush.
 *
 * ## Why it is not two trims
 *
 * It is implemented as two trims, and that is deliberate: they already know about source handles,
 * locked tracks, keyframe shifting and collisions, and re-deriving any of that here would be a second
 * definition that could disagree. What this adds is the part neither trim can know — that the two are
 * **one gesture**, and must both succeed or neither happen.
 *
 * The order matters. The outgoing clip is shortened before the incoming one is lengthened whenever
 * the boundary moves left, and the reverse when it moves right, because the intermediate state has to
 * be legal: extending a clip into space its neighbour still occupies is a collision, and the collision
 * check is in the trims rather than here.
 *
 * ## What bounds it
 *
 * Both sides. The outgoing clip cannot be rolled shorter than one frame, nor longer than its source
 * has material for; the incoming clip has the same two limits mirrored. A roll that would break
 * either is refused whole, rather than moving as far as it can — unlike a *drag*, where stopping
 * short is what the hand asked for. Here the two edges must stay flush, and a partial roll that
 * moved one edge and not the other would open the gap this operation exists to prevent.
 */

export interface RollRequest {
  readonly document: TimelineDocument;
  /** The clip ending at the cut. */
  readonly outgoing: ClipId;
  /** The clip starting at the cut. */
  readonly incoming: ClipId;
  /** Frames to move the boundary by; negative moves it earlier. */
  readonly delta: number;
  /** Source lengths, so a roll cannot ask for material a file does not have. */
  readonly sources?: SourceBoundsResolver;
}

/**
 * A cut two clips share, or `undefined` when they do not share one.
 *
 * The check that makes a roll meaningful: the clips must be on the same track and the first must end
 * exactly where the second begins. Two clips with a gap between them have no cut to move, and rolling
 * across a gap would silently close it — a ripple, which is a different edit with a different name.
 */
export function sharedCut(
  document: TimelineDocument,
  outgoing: ClipId,
  incoming: ClipId,
): { readonly track: TrackId; readonly frame: number } | undefined {
  const left = locateClip(document, outgoing);
  const right = locateClip(document, incoming);
  if (left === undefined || right === undefined) return undefined;
  if (left.track.id !== right.track.id) return undefined;

  const cut = endExclusive(left.clip.span);
  return cut === right.clip.span.start ? { track: left.track.id, frame: cut } : undefined;
}

export function rollEdit(request: RollRequest): Result<TimelineDocument, EditError> {
  const { document, outgoing, incoming, delta } = request;

  const cut = sharedCut(document, outgoing, incoming);
  if (cut === undefined) {
    // Not a collision and not a missing clip: the two simply do not meet. Reported as its own thing
    // so the UI can say "these clips do not share a cut" rather than blaming one of them.
    return err({ kind: 'no-shared-cut', clips: [outgoing, incoming] });
  }

  if (delta === 0) return ok(document);

  const bounds = request.sources === undefined ? {} : { sources: request.sources };

  // Shorten first, lengthen second. The intermediate document has to be legal, and extending a clip
  // into frames its neighbour has not yet released is exactly the collision the trims refuse.
  const first = delta < 0 ? trimOutgoing : trimIncoming;
  const second = delta < 0 ? trimIncoming : trimOutgoing;

  const once = first(document, request, bounds);
  if (!once.ok) return once;

  const twice = second(once.value, request, bounds);
  // Whole or nothing: a partial roll moves one edge and leaves the other, which opens the very gap
  // this operation exists to prevent. `once` is discarded rather than returned.
  if (!twice.ok) return twice;

  return ok(twice.value);
}

function trimOutgoing(
  document: TimelineDocument,
  request: RollRequest,
  bounds: { sources?: SourceBoundsResolver },
): Result<TimelineDocument, EditError> {
  return trimClipEnd(document, request.outgoing, request.delta, bounds);
}

function trimIncoming(
  document: TimelineDocument,
  request: RollRequest,
  _bounds: { sources?: SourceBoundsResolver },
): Result<TimelineDocument, EditError> {
  // `trimClipStart` takes no bounds: extending a head reads material *before* the in-point, which the
  // clip already knows it has. Only a tail extension needs the file's length.
  return trimClipStart(document, request.incoming, request.delta);
}

/**
 * How far a cut can move, in each direction, before one side runs out.
 *
 * Offered so a drag can be clamped to what is legal rather than discovering it by being refused —
 * the same reason `limitedStart` exists for a move. Both numbers are magnitudes: `earliest` is how
 * many frames the cut may move left, `latest` how many right, and either may be zero.
 *
 * Source material is *not* consulted here. A file's length is an asynchronous question and this is
 * called on every pointer move; the trims enforce it exactly, and a roll clamped only by span
 * lengths refuses at the file's edge rather than sliding past it.
 */
export function rollRange(
  document: TimelineDocument,
  outgoing: ClipId,
  incoming: ClipId,
): { readonly earliest: number; readonly latest: number } {
  const cut = sharedCut(document, outgoing, incoming);
  if (cut === undefined) return { earliest: 0, latest: 0 };

  const left = locateClip(document, outgoing);
  const right = locateClip(document, incoming);
  if (left === undefined || right === undefined) return { earliest: 0, latest: 0 };

  // One frame has to survive on each side: a clip rolled to nothing would be deleted by an edit whose
  // name says it moves a boundary, which is not a thing any editor should do quietly.
  return {
    earliest: Math.max(0, left.clip.span.duration - 1),
    latest: Math.max(0, right.clip.span.duration - 1),
  };
}

/** Clamps a wanted delta to what the two spans allow. */
export function clampRoll(
  document: TimelineDocument,
  outgoing: ClipId,
  incoming: ClipId,
  delta: number,
): number {
  const range = rollRange(document, outgoing, incoming);
  return Math.max(-range.earliest, Math.min(range.latest, delta));
}

/** The clip after a given one on its own track, when they are flush. */
export function clipAfter(document: TimelineDocument, clip: ClipId): ClipId | undefined {
  const located = locateClip(document, clip);
  if (located === undefined) return undefined;

  const end = endExclusive(located.clip.span);
  for (const candidate of trackClips(located.track)) {
    if (candidate.id === clip) continue;
    if (candidate.span.start === end) return candidate.id;
  }
  return undefined;
}

/** The clip before a given one on its own track, when they are flush. */
export function clipBefore(document: TimelineDocument, clip: ClipId): ClipId | undefined {
  const located = locateClip(document, clip);
  if (located === undefined) return undefined;

  const start = located.clip.span.start;
  for (const candidate of trackClips(located.track)) {
    if (candidate.id === clip) continue;
    if (endExclusive(candidate.span) === start) return candidate.id;
  }
  return undefined;
}

function ok(document: TimelineDocument): Result<TimelineDocument, EditError> {
  return { ok: true, value: document };
}

function err(error: EditError): Result<TimelineDocument, EditError> {
  return { ok: false, error };
}

/** Re-exported for callers that build a request without importing the whole module. */
export function rollTo(
  document: TimelineDocument,
  outgoing: ClipId,
  incoming: ClipId,
  frame: number,
  sources?: SourceBoundsResolver,
): Result<TimelineDocument, EditError> {
  const cut = sharedCut(document, outgoing, incoming);
  if (cut === undefined) return err({ kind: 'no-shared-cut', clips: [outgoing, incoming] });
  return rollEdit({
    document,
    outgoing,
    incoming,
    delta: frameIndex(Math.max(0, frame)) - cut.frame,
    ...(sources !== undefined ? { sources } : {}),
  });
}
