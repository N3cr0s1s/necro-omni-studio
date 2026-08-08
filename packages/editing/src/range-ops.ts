import {
  type FrameIndex,
  type FrameSpan,
  type Marker,
  type Result,
  type TimelineDocument,
  documentEnd,
  endExclusive,
  frameIndex,
  ok,
  spanFromBounds,
} from '@nos/core';
import type { EditError } from './errors.js';

/**
 * The in/out range and the markers on it.
 *
 * The document already treats the work range as load-bearing — it bounds looped playback, it is the
 * default export range, and it contributes snap candidates — so these operations only decide *what
 * the marks mean when they conflict*, which is the whole design question here.
 *
 * The rule throughout: **a mark is never refused**. Pressing in past the out point is the ordinary
 * way an editor moves a range forward, not a mistake to reject, so the far mark yields rather than
 * the near one failing. An operation that made a user clear the range before re-marking it would be
 * technically correct and unusable.
 */

/** How the range answers a mark that would invert it. */
export type MarkOutcome =
  | { readonly kind: 'set' }
  /** The opposite mark moved out of the way to keep the range at least one frame long. */
  | { readonly kind: 'pushed'; readonly other: FrameIndex };

export interface RangeResult {
  readonly document: TimelineDocument;
  readonly range: FrameSpan;
  readonly outcome: MarkOutcome;
}

/**
 * Marks the in point.
 *
 * With no range yet, the out point lands at the end of the sequence rather than one frame later:
 * marking in is nearly always the start of "render from here on", and a one-frame range would have
 * to be widened by hand every time.
 */
export function markIn(document: TimelineDocument, at: FrameIndex): Result<RangeResult, EditError> {
  const current = document.sequence.workRange;
  const end = current === undefined ? laterOf(documentEnd(document), next(at)) : endExclusive(current);

  if (at < end) return ok(applied(document, spanFromBounds(at, end), { kind: 'set' }));

  // In moved past out: the out point follows rather than the mark being refused.
  const pushed = next(at);
  return ok(applied(document, spanFromBounds(at, pushed), { kind: 'pushed', other: pushed }));
}

/**
 * Marks the out point.
 *
 * The frame under the playhead is *included*, because that is what an editor means by "out here" —
 * spans are half-open internally, and the conversion belongs at this boundary rather than in every
 * caller.
 */
export function markOut(document: TimelineDocument, at: FrameIndex): Result<RangeResult, EditError> {
  const current = document.sequence.workRange;
  const end = next(at);
  const start = current === undefined ? frameIndex(0) : current.start;

  if (start < end) return ok(applied(document, spanFromBounds(start, end), { kind: 'set' }));

  const pushed = at;
  return ok(applied(document, spanFromBounds(pushed, end), { kind: 'pushed', other: pushed }));
}

/** Sets both marks at once, as dragging the range bar does. */
export function setWorkRange(document: TimelineDocument, range: FrameSpan): Result<RangeResult, EditError> {
  return ok(applied(document, range, { kind: 'set' }));
}

/**
 * Removes the range.
 *
 * Absent rather than "the whole sequence": the two behave the same today, but a stored range that
 * happens to match the content would silently stop tracking it as clips are added.
 */
export function clearWorkRange(document: TimelineDocument): TimelineDocument {
  if (document.sequence.workRange === undefined) return document;
  const { workRange: _removed, ...sequence } = document.sequence;
  return { ...document, sequence };
}

/**
 * Adds a marker, replacing any marker already on that frame.
 *
 * One per frame, because two markers on one frame draw on top of each other and the second is only
 * discoverable by deleting the first.
 */
export function addMarker(document: TimelineDocument, marker: Marker): TimelineDocument {
  const others = document.sequence.markers.filter((existing) => existing.frame !== marker.frame);
  return withMarkers(document, sortByFrame([...others, marker]));
}

export function removeMarker(document: TimelineDocument, at: FrameIndex): TimelineDocument {
  const kept = document.sequence.markers.filter((marker) => marker.frame !== at);
  if (kept.length === document.sequence.markers.length) return document;
  return withMarkers(document, kept);
}

/**
 * The marker at or before a frame, for "jump to previous marker".
 *
 * Nearest-at-or-before rather than nearest overall: navigation that could jump backwards when the
 * user asked to go forward is worse than navigation that occasionally does nothing.
 */
export function markerBefore(document: TimelineDocument, frame: FrameIndex): Marker | undefined {
  let found: Marker | undefined;
  for (const marker of document.sequence.markers) {
    if (marker.frame < frame && (found === undefined || marker.frame > found.frame)) found = marker;
  }
  return found;
}

export function markerAfter(document: TimelineDocument, frame: FrameIndex): Marker | undefined {
  let found: Marker | undefined;
  for (const marker of document.sequence.markers) {
    if (marker.frame > frame && (found === undefined || marker.frame < found.frame)) found = marker;
  }
  return found;
}

function withMarkers(document: TimelineDocument, markers: readonly Marker[]): TimelineDocument {
  return { ...document, sequence: { ...document.sequence, markers } };
}

/** Kept in frame order so the UI never has to sort to draw or to navigate. */
function sortByFrame(markers: readonly Marker[]): readonly Marker[] {
  return [...markers].sort((left, right) => left.frame - right.frame);
}

function applied(document: TimelineDocument, range: FrameSpan, outcome: MarkOutcome): RangeResult {
  return {
    document: { ...document, sequence: { ...document.sequence, workRange: range } },
    range,
    outcome,
  };
}

function next(frame: FrameIndex): FrameIndex {
  return frameIndex(frame + 1);
}

function laterOf(left: FrameIndex, right: FrameIndex): FrameIndex {
  return left > right ? left : right;
}
