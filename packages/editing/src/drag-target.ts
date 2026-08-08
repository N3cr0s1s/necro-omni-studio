import type { Clip, ClipId, FrameCount, FrameIndex, FrameSpan, Track, TrackId, TrackKind } from '@nos/core';
import { TRACK_ACCEPTS, endExclusive, frameIndex, overlaps } from '@nos/core';

/**
 * Where a dragged clip would land: which track, and how far it can actually go.
 *
 * Two reports, one cause. A clip could not be moved between tracks *at all* — the drag read only the
 * pointer's horizontal movement, so the vertical axis did nothing, on video and audio alike. And a
 * clip could not be dragged back toward a neighbour "even though there is room", because a move that
 * overlapped anything was refused outright: the whole gesture failed and the clip snapped back to
 * where it started, rather than travelling as far as it legitimately could.
 *
 * Both are decisions about the document, and both are wrong in ways a rendered drag cannot show. So
 * they live here: given the tracks, a vertical offset and a wanted position, what happens.
 *
 * The rule for a blocked move is **go as far as possible, never nothing**. An editor that refuses a
 * gesture teaches the user to make smaller gestures; one that stops at the obstacle does what was
 * asked as nearly as it can, and the obstacle is visible on screen the whole time.
 */

export interface DragTargetTrack {
  readonly track: TrackId;
  readonly kind: TrackKind;
  /** True when this is not the track the clip started on. */
  readonly changed: boolean;
  /**
   * Rows travelled, as a signed count among the tracks that accept the clip.
   *
   * The number a *group* moves by. A linked video and audio are dragged together, and applying the
   * same row delta within each clip's own kind is what keeps the pair a pair — a target track alone
   * says nothing about where the audio should go.
   */
  readonly deltaRows: number;
}

/**
 * The track a vertical offset points at, among those that accept the clip.
 *
 * Tracks that cannot hold the clip are skipped rather than reported and refused: dragging a video
 * over the audio rows must not park it there, and stopping the drag dead at the boundary is the
 * behaviour that made vertical movement feel broken before it was possible at all.
 *
 * `undefined` when there is no acceptable track — which cannot happen while the clip's own track
 * exists, and is therefore the caller's cue to leave the clip where it is.
 */
export function trackForOffset(
  tracks: readonly Track[],
  clip: Clip,
  currentTrack: TrackId,
  offsetY: number,
): DragTargetTrack | undefined {
  const eligible = tracks.filter((track) => accepts(track, clip));
  if (eligible.length === 0) return undefined;

  // Measured against the *eligible* rows only, so a drag across an audio track does not consume the
  // vertical distance a video needed to reach the next video track.
  const from = eligible.findIndex((track) => track.id === currentTrack);
  if (from < 0) return undefined;

  const rows = eligible.length;
  const height = averageHeight(eligible);
  // Rounded, so the clip changes row when the pointer passes the halfway line rather than a whole
  // row late — which reads as the drag lagging behind the hand.
  const wanted = from + Math.round(offsetY / height);
  const index = Math.min(rows - 1, Math.max(0, wanted));
  const target = eligible[index];
  if (target === undefined) return undefined;

  return {
    track: target.id,
    kind: target.kind,
    changed: target.id !== currentTrack,
    deltaRows: index - from,
  };
}

function accepts(track: Track, clip: Clip): boolean {
  return (TRACK_ACCEPTS[track.kind] as readonly string[]).includes(clip.kind);
}

/**
 * The row height used to turn a vertical distance into a number of rows.
 *
 * An average rather than each row's own height, because rows are individually resizable and walking
 * them exactly would make a drag's feel depend on which rows it happened to pass over — the same
 * gesture landing differently depending on where it started. A single step size is predictable, and
 * predictability is the whole complaint.
 */
function averageHeight(tracks: readonly Track[]): number {
  const total = tracks.reduce((sum, track) => sum + track.height, 0);
  return total > 0 ? total / tracks.length : 1;
}

/**
 * How far a clip can move toward a wanted start without overlapping anything on the target track.
 *
 * The wanted position when it is free. Otherwise the closest position *in the same direction* that
 * is not blocked — flush against the obstacle — and the clip's current start when even that is not
 * available. Never a refusal: "there is room and I cannot use it" is the report this answers.
 */
export function limitedStart(
  target: Track,
  moving: readonly ClipId[],
  span: FrameSpan,
  wantedStart: FrameIndex,
  options: { readonly changingTrack?: boolean } = {},
): FrameIndex {
  const duration = span.duration;
  const others = clipsOf(target).filter((clip) => !moving.includes(clip.id));
  if (others.length === 0) return frameIndex(Math.max(0, wantedStart));

  const wanted = Math.max(0, wantedStart);
  if (isFree(others, wanted, duration)) return frameIndex(wanted);

  // Every edge a clip of this length could sit flush against, on either side of every obstacle.
  const before = others.map((clip) => clip.span.start - duration);
  const after = others.map((clip) => endExclusive(clip.span) as number);

  // A drag along one track has a direction, and only the gaps between where the clip is and where it
  // was asked to go may be used — otherwise a clip dragged left lands to the right of what blocked
  // it, because that gap happened to be nearer.
  //
  // A drag onto a *different* track has no direction: the pointer moved vertically, and the clip's
  // old position on its old track says nothing about which way it should slide on the new one.
  // Restricting it there is what made dropping a clip onto an occupied row fail outright.
  const candidates =
    options.changingTrack === true
      ? [...before, ...after]
      : wanted < span.start
        ? after.filter((edge) => edge >= wanted && edge <= span.start)
        : before.filter((edge) => edge <= wanted && edge >= span.start);

  const reachable = candidates
    .map((edge) => Math.max(0, edge))
    .filter((edge) => isFree(others, edge, duration))
    // The one nearest to what was asked for, which is the furthest the clip can travel.
    .sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));

  return frameIndex(reachable[0] ?? span.start);
}

function isFree(others: readonly Clip[], start: number, duration: FrameCount): boolean {
  const candidate: FrameSpan = { start: frameIndex(start), duration };
  return !others.some((clip) => overlaps(clip.span, candidate));
}

function clipsOf(track: Track): readonly Clip[] {
  return (track as { clips?: readonly Clip[] }).clips ?? [];
}

/**
 * The tracks that can hold a clip, in document order.
 *
 * The list a row delta is applied within, which is why it excludes everything else: a video moving
 * down one row must land on the next *video* track, not on whatever row happens to be beneath it.
 */
export function eligibleTracksFor(tracks: readonly Track[], clip: Clip): readonly TrackId[] {
  return tracks.filter((track) => accepts(track, clip)).map((track) => track.id);
}
