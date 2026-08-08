import {
  type FrameCount,
  type FrameIndex,
  advance,
  frameCount,
  frameIndex,
  shiftFrames,
} from './frame-time.js';

/**
 * A half-open frame range `[start, start + duration)`.
 *
 * Half-open is the only interval convention that makes adjacency unambiguous: two
 * clips touch exactly when `endExclusive(a) === b.start`, with no "does the last
 * frame belong to the left or the right clip" question at every cut. Every overlap,
 * trim and ripple operation in the editor is expressed through this algebra.
 */
export interface FrameSpan {
  readonly start: FrameIndex;
  readonly duration: FrameCount;
}

export function frameSpan(start: FrameIndex, duration: FrameCount): FrameSpan {
  return { start, duration };
}

export function spanFromBounds(start: FrameIndex, endExclusive: FrameIndex): FrameSpan {
  if (endExclusive < start) {
    throw new RangeError(`Span end ${endExclusive} precedes start ${start}`);
  }
  return { start, duration: frameCount(endExclusive - start) };
}

export const EMPTY_SPAN: FrameSpan = { start: 0 as FrameIndex, duration: 0 as FrameCount };

/** First frame after the span. Not a frame the span contains. */
export function endExclusive(span: FrameSpan): FrameIndex {
  return advance(span.start, span.duration);
}

/**
 * Last frame the span contains. Throws on an empty span, which has no last frame —
 * callers that might hold one should check `isEmpty` first.
 */
export function lastFrame(span: FrameSpan): FrameIndex {
  if (isEmpty(span)) {
    throw new RangeError('An empty span has no last frame');
  }
  return shiftFrames(span.start, span.duration - 1);
}

export function isEmpty(span: FrameSpan): boolean {
  return span.duration === 0;
}

export function containsFrame(span: FrameSpan, position: FrameIndex): boolean {
  return position >= span.start && position < endExclusive(span);
}

export function containsSpan(outer: FrameSpan, inner: FrameSpan): boolean {
  if (isEmpty(inner)) return containsFrame(outer, inner.start) || inner.start === outer.start;
  return inner.start >= outer.start && endExclusive(inner) <= endExclusive(outer);
}

/**
 * True when the spans share at least one frame.
 *
 * Empty spans never overlap anything — a zero-length span is a cursor, not a region,
 * and treating it as overlapping would make collision checks reject valid inserts.
 */
export function overlaps(a: FrameSpan, b: FrameSpan): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  return a.start < endExclusive(b) && b.start < endExclusive(a);
}

/** True when the spans touch without sharing a frame, in either order. */
export function isAdjacent(a: FrameSpan, b: FrameSpan): boolean {
  return endExclusive(a) === b.start || endExclusive(b) === a.start;
}

export function intersection(a: FrameSpan, b: FrameSpan): FrameSpan | undefined {
  if (!overlaps(a, b)) return undefined;
  const start = frameIndex(Math.max(a.start, b.start));
  const end = frameIndex(Math.min(endExclusive(a), endExclusive(b)));
  return spanFromBounds(start, end);
}

/** Smallest span covering both inputs, including any gap between them. */
export function union(a: FrameSpan, b: FrameSpan): FrameSpan {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  const start = frameIndex(Math.min(a.start, b.start));
  const end = frameIndex(Math.max(endExclusive(a), endExclusive(b)));
  return spanFromBounds(start, end);
}

export function translate(span: FrameSpan, delta: number): FrameSpan {
  return { start: shiftFrames(span.start, delta), duration: span.duration };
}

/**
 * Moves the start edge, keeping the end fixed — a head trim.
 *
 * A positive delta shortens the span. Trimming past the end clamps to empty rather
 * than throwing, so a drag that overshoots collapses the clip instead of aborting
 * mid-gesture.
 */
export function trimStart(span: FrameSpan, delta: number): FrameSpan {
  const end = endExclusive(span);
  const start = frameIndex(Math.min(span.start + delta, end));
  return spanFromBounds(start, end);
}

/** Moves the end edge, keeping the start fixed — a tail trim. */
export function trimEnd(span: FrameSpan, delta: number): FrameSpan {
  const end = frameIndex(Math.max(endExclusive(span) + delta, span.start));
  return spanFromBounds(span.start, end);
}

/**
 * Splits a span at an absolute frame.
 *
 * Returns `undefined` when the cut falls on or outside a boundary: cutting at a clip's
 * own edges is a no-op, not an error, and must not produce a zero-length clip.
 */
export function split(
  span: FrameSpan,
  at: FrameIndex,
): readonly [FrameSpan, FrameSpan] | undefined {
  if (at <= span.start || at >= endExclusive(span)) return undefined;
  return [spanFromBounds(span.start, at), spanFromBounds(at, endExclusive(span))];
}

/** Orders spans by start, then by duration, so sorts are stable and deterministic. */
export function compareSpans(a: FrameSpan, b: FrameSpan): number {
  return a.start - b.start || a.duration - b.duration;
}

export function spansEqual(a: FrameSpan, b: FrameSpan): boolean {
  return a.start === b.start && a.duration === b.duration;
}

/**
 * Subtracts `cut` from `span`, returning the surviving pieces in timeline order.
 *
 * Yields zero pieces when the cut swallows the span, two when it punches a hole in
 * the middle. Ripple delete and mask-range edits are both expressed with this.
 */
export function subtractSpan(span: FrameSpan, cut: FrameSpan): readonly FrameSpan[] {
  if (!overlaps(span, cut)) return [span];
  const pieces: FrameSpan[] = [];
  if (span.start < cut.start) {
    pieces.push(spanFromBounds(span.start, cut.start));
  }
  const cutEnd = endExclusive(cut);
  const spanEnd = endExclusive(span);
  if (cutEnd < spanEnd) {
    pieces.push(spanFromBounds(cutEnd, spanEnd));
  }
  return pieces;
}
