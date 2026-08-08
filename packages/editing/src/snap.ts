import {
  type FrameIndex,
  type TimelineDocument,
  type TrackId,
  endExclusive,
  frameIndex,
  trackClips,
} from '@nos/core';

/**
 * Snapping.
 *
 * A snap target is a frame the user is likely to have meant. The spec lists snap as a timeline
 * feature without defining its semantics, so the rules here are chosen to make dragging predictable:
 *
 * - The threshold is in **pixels**, converted to frames by the caller's zoom level. A frame-based
 *   threshold would snap aggressively when zoomed out (where one pixel is many frames) and barely at
 *   all when zoomed in — the opposite of what feels right.
 * - Ties break toward the *nearest* candidate, and on an exact tie toward the earlier frame, so the
 *   same gesture always produces the same result.
 * - Candidates carry a `kind` so the UI can draw a different indicator for a playhead snap than for
 *   a clip-edge snap, and so a future preference can weight them.
 */

export type SnapKind = 'clip-start' | 'clip-end' | 'playhead' | 'marker' | 'work-range' | 'origin';

export interface SnapCandidate {
  readonly frame: FrameIndex;
  readonly kind: SnapKind;
  /** Present for clip edges, so the UI can highlight the clip that was snapped to. */
  readonly track?: TrackId;
}

export interface SnapResult {
  readonly frame: FrameIndex;
  /** Absent when nothing was within the threshold; `frame` is then the input, unchanged. */
  readonly snappedTo?: SnapCandidate;
}

export interface SnapOptions {
  /** Distance within which a candidate wins, in frames (caller converts from pixels). */
  readonly thresholdFrames: number;
  /** Excluded from candidate collection — a clip must not snap to its own edges while dragging. */
  readonly ignoreClips?: readonly string[];
  /** Restricts clip-edge candidates to these tracks. Omit to consider all. */
  readonly tracks?: readonly TrackId[];
}

/**
 * Collects every frame an edit could snap to.
 *
 * Frame 0 is always a candidate: the start of the timeline is the single most common snap target, and
 * on an empty track there would otherwise be nothing to snap to at all.
 */
export function collectSnapCandidates(
  document: TimelineDocument,
  playhead: FrameIndex,
  options: Pick<SnapOptions, 'ignoreClips' | 'tracks'> = {},
): readonly SnapCandidate[] {
  const ignore = new Set(options.ignoreClips ?? []);
  const trackFilter = options.tracks === undefined ? undefined : new Set(options.tracks);

  const candidates: SnapCandidate[] = [
    { frame: frameIndex(0), kind: 'origin' },
    { frame: playhead, kind: 'playhead' },
  ];

  for (const track of document.sequence.tracks) {
    if (trackFilter !== undefined && !trackFilter.has(track.id)) continue;
    for (const clip of trackClips(track)) {
      if (ignore.has(clip.id)) continue;
      candidates.push({ frame: clip.span.start, kind: 'clip-start', track: track.id });
      candidates.push({ frame: endExclusive(clip.span), kind: 'clip-end', track: track.id });
    }
  }

  for (const marker of document.sequence.markers) {
    candidates.push({ frame: marker.frame, kind: 'marker' });
  }

  const workRange = document.sequence.workRange;
  if (workRange !== undefined) {
    candidates.push({ frame: workRange.start, kind: 'work-range' });
    candidates.push({ frame: endExclusive(workRange), kind: 'work-range' });
  }

  return candidates;
}

/**
 * Snaps a frame to the nearest candidate within the threshold.
 *
 * A zero or negative threshold disables snapping entirely, which is how the UI implements the
 * "hold to override snap" modifier without a separate code path.
 */
export function snapFrame(
  frame: FrameIndex,
  candidates: readonly SnapCandidate[],
  thresholdFrames: number,
): SnapResult {
  if (thresholdFrames <= 0) return { frame };

  let best: SnapCandidate | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = Math.abs(candidate.frame - frame);
    if (distance > thresholdFrames) continue;
    // Strictly-less keeps the first candidate on an exact tie. Candidates are collected in a stable
    // order, so the same gesture always resolves the same way.
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best === undefined ? { frame } : { frame: best.frame, snappedTo: best };
}

/**
 * Snaps a whole span by whichever of its edges is closer to a candidate.
 *
 * Moving a clip must consider both edges: a user aligning a clip's *end* to a cut expects that to
 * snap, not only its start. The span keeps its duration — the snap translates it.
 */
export function snapSpanTranslation(
  start: FrameIndex,
  durationFrames: number,
  candidates: readonly SnapCandidate[],
  thresholdFrames: number,
): SnapResult {
  const startResult = snapFrame(start, candidates, thresholdFrames);
  const endResult = snapFrame(frameIndex(start + durationFrames), candidates, thresholdFrames);

  const startDistance =
    startResult.snappedTo === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(startResult.frame - start);
  const endDistance =
    endResult.snappedTo === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(endResult.frame - (start + durationFrames));

  if (startDistance === Number.POSITIVE_INFINITY && endDistance === Number.POSITIVE_INFINITY) {
    return { frame: start };
  }

  // The start edge wins an exact tie, because that is the edge under the pointer in the common case
  // of grabbing a clip near its left side.
  if (startDistance <= endDistance) {
    return startResult.snappedTo === undefined
      ? { frame: start }
      : { frame: startResult.frame, snappedTo: startResult.snappedTo };
  }

  const translated = frameIndex(endResult.frame - durationFrames);
  return endResult.snappedTo === undefined
    ? { frame: start }
    : { frame: translated, snappedTo: endResult.snappedTo };
}

/**
 * Converts a pixel threshold to frames at the current zoom.
 *
 * `framesPerPixel` is the timeline's zoom unit — the mockups display it as `4 f/px`. Rounded up and
 * floored at one frame, so snapping never becomes impossible when zoomed all the way in.
 */
export function snapThresholdFrames(thresholdPixels: number, framesPerPixel: number): number {
  return Math.max(1, Math.ceil(thresholdPixels * framesPerPixel));
}

/** Default snap distance in pixels. Wide enough to be reachable, narrow enough not to fight. */
export const DEFAULT_SNAP_PIXELS = 8;
