import {
  type FrameIndex,
  type FrameRate,
  type FrameSpan,
  displayFrameRate,
  frameIndex,
  framesToSecondsNumber,
  nominalRate,
  spanFromBounds,
} from '@nos/core';

/**
 * Timeline viewport: the mapping between frames and pixels.
 *
 * Pure and separately tested, because everything visible in the timeline depends on it — clip
 * geometry, the playhead, hit testing, ruler ticks, snap thresholds. A rounding mistake here is not a
 * cosmetic problem: it makes a clip's drawn edge disagree with the frame the click resolves to, and
 * the user sees cuts land one frame off what they aimed at.
 *
 * `framesPerPixel` is the zoom unit the mockups display (`4 f/px`). Frames-per-pixel rather than
 * pixels-per-frame because the useful range is "many frames per pixel" when zoomed out, and that
 * keeps the number readable instead of a long decimal.
 */
export interface TimelineViewport {
  /** Frames covered by one horizontal pixel. Larger means zoomed further out. */
  readonly framesPerPixel: number;
  /** Leftmost visible frame. */
  readonly scrollFrame: FrameIndex;
  /** Width of the lane area in pixels, excluding the track-header column. */
  readonly widthPx: number;
  readonly frameRate: FrameRate;
}

/**
 * Zoom limits.
 *
 * The floor of 1/16 means one frame can occupy 16 px — enough to grab a single-frame clip. The
 * ceiling of 256 keeps a 20-minute project (the spec's stated limit) inside a couple of screens, past
 * which further zoom-out stops being informative.
 */
export const MIN_FRAMES_PER_PIXEL = 1 / 16;
export const MAX_FRAMES_PER_PIXEL = 256;

export function clampZoom(framesPerPixel: number): number {
  if (!Number.isFinite(framesPerPixel) || framesPerPixel <= 0) return 1;
  return Math.min(Math.max(framesPerPixel, MIN_FRAMES_PER_PIXEL), MAX_FRAMES_PER_PIXEL);
}

export function createViewport(options: {
  readonly framesPerPixel?: number;
  readonly scrollFrame?: FrameIndex;
  readonly widthPx: number;
  readonly frameRate: FrameRate;
}): TimelineViewport {
  return {
    framesPerPixel: clampZoom(options.framesPerPixel ?? 4),
    scrollFrame: options.scrollFrame ?? frameIndex(0),
    widthPx: Math.max(0, options.widthPx),
    frameRate: options.frameRate,
  };
}

/**
 * Pixel offset of a frame from the left edge of the lane area.
 *
 * Deliberately *not* rounded. Sub-pixel positions are what let a clip edge sit exactly where its
 * frame is; rounding here accumulates into visible drift between a clip's body and the ruler tick it
 * should align with. Rounding happens once, at hit testing, where an integer frame is required.
 */
export function frameToPx(viewport: TimelineViewport, frame: FrameIndex): number {
  return (frame - viewport.scrollFrame) / viewport.framesPerPixel;
}

/** The frame at a pixel offset, rounded to the nearest whole frame. */
export function pxToFrame(viewport: TimelineViewport, px: number): FrameIndex {
  return frameIndex(Math.round(viewport.scrollFrame + px * viewport.framesPerPixel));
}

/**
 * The frame at a pixel offset, floored.
 *
 * Used for hit testing rather than `pxToFrame`: a click anywhere inside the pixel column that
 * represents frame N must resolve to N. Rounding would resolve the right half of that column to
 * N+1, so clicking the visible right edge of a clip would select the gap beyond it.
 */
export function pxToFrameFloor(viewport: TimelineViewport, px: number): FrameIndex {
  return frameIndex(Math.floor(viewport.scrollFrame + px * viewport.framesPerPixel));
}

/** Width in pixels of a frame count at the current zoom. */
export function framesToPx(viewport: TimelineViewport, frames: number): number {
  return frames / viewport.framesPerPixel;
}

export function pxToFrames(viewport: TimelineViewport, px: number): number {
  return px * viewport.framesPerPixel;
}

/** Frames visible in the viewport. */
export function visibleSpan(viewport: TimelineViewport): FrameSpan {
  const end = frameIndex(Math.ceil(viewport.scrollFrame + viewport.widthPx * viewport.framesPerPixel));
  return spanFromBounds(viewport.scrollFrame, end);
}

/**
 * Whether a span intersects the viewport.
 *
 * Used to skip rendering off-screen clips. The one-pixel margin keeps a clip whose edge lands exactly
 * on the boundary from flickering as the timeline scrolls.
 */
export function isSpanVisible(viewport: TimelineViewport, span: FrameSpan): boolean {
  const margin = viewport.framesPerPixel;
  const visible = visibleSpan(viewport);
  return (
    span.start < visible.start + visible.duration + margin &&
    span.start + span.duration > visible.start - margin
  );
}

/** Geometry for drawing a span, clamped so a long clip does not produce a huge DOM element. */
export interface SpanGeometry {
  readonly leftPx: number;
  readonly widthPx: number;
  /** True when the span extends past the left edge, so the body should not draw a start handle. */
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

export function spanGeometry(viewport: TimelineViewport, span: FrameSpan): SpanGeometry {
  const rawLeft = frameToPx(viewport, span.start);
  const rawWidth = framesToPx(viewport, span.duration);
  const rawRight = rawLeft + rawWidth;

  // Clamping to the viewport, plus a small overhang so borders and radii stay off-screen rather than
  // being drawn at the clamped edge.
  const overhang = 24;
  const left = Math.max(rawLeft, -overhang);
  const right = Math.min(rawRight, viewport.widthPx + overhang);

  return {
    leftPx: left,
    widthPx: Math.max(0, right - left),
    clippedStart: rawLeft < -overhang,
    clippedEnd: rawRight > viewport.widthPx + overhang,
  };
}

/**
 * Zooms around a fixed pixel, keeping the frame under the cursor in place.
 *
 * Anchoring to the pointer is what makes wheel-zoom feel controlled: without it the content slides
 * out from under the cursor and the user has to re-find their position after every zoom step.
 */
export function zoomAt(
  viewport: TimelineViewport,
  anchorPx: number,
  nextFramesPerPixel: number,
): TimelineViewport {
  const anchorFrame = viewport.scrollFrame + anchorPx * viewport.framesPerPixel;
  const clamped = clampZoom(nextFramesPerPixel);
  const nextScroll = Math.max(0, Math.round(anchorFrame - anchorPx * clamped));
  return { ...viewport, framesPerPixel: clamped, scrollFrame: frameIndex(nextScroll) };
}

/** Scrolls by a pixel delta, never past frame zero. */
export function scrollByPx(viewport: TimelineViewport, deltaPx: number): TimelineViewport {
  const next = Math.max(0, Math.round(viewport.scrollFrame + deltaPx * viewport.framesPerPixel));
  return { ...viewport, scrollFrame: frameIndex(next) };
}

/**
 * Scrolls so a frame is visible, with a margin.
 *
 * Returns the same viewport when the frame is already comfortably inside, so following the playhead
 * during playback does not scroll on every frame — only when it approaches an edge.
 */
export function scrollToReveal(
  viewport: TimelineViewport,
  frame: FrameIndex,
  marginPx = 80,
): TimelineViewport {
  const px = frameToPx(viewport, frame);
  if (px >= marginPx && px <= viewport.widthPx - marginPx) return viewport;

  // Centre it: an edge-triggered scroll that only just reveals the frame would re-trigger on the
  // next frame of playback and produce continuous single-pixel scrolling.
  const centred = frame - (viewport.widthPx / 2) * viewport.framesPerPixel;
  return { ...viewport, scrollFrame: frameIndex(Math.max(0, Math.round(centred))) };
}

/** Zoom that fits a span to the viewport width. */
export function zoomToFit(viewport: TimelineViewport, span: FrameSpan, paddingPx = 24): TimelineViewport {
  const usableWidth = Math.max(1, viewport.widthPx - paddingPx * 2);
  const framesPerPixel = clampZoom(Math.max(span.duration, 1) / usableWidth);
  const scroll = Math.max(0, Math.round(span.start - paddingPx * framesPerPixel));
  return { ...viewport, framesPerPixel, scrollFrame: frameIndex(scroll) };
}

/** A ruler tick. Major ticks carry a label; minor ticks are unlabelled marks. */
export interface RulerTick {
  readonly frame: FrameIndex;
  readonly px: number;
  readonly major: boolean;
  /** Present on major ticks only. */
  readonly label?: string;
}

/**
 * Candidate label intervals, in seconds.
 *
 * A human-friendly ladder rather than powers of two: a ruler labelled every 8 seconds is harder to
 * read than one labelled every 10, because the reader has to do arithmetic. Sub-second entries carry
 * the zoomed-in range where frame-level work happens.
 */
const SECOND_INTERVALS: readonly number[] = [
  1 / 30,
  1 / 15,
  1 / 10,
  1 / 5,
  1 / 2,
  1,
  2,
  5,
  10,
  15,
  30,
  60,
  120,
  300,
  600,
  900,
  1800,
  3600,
];

/** Minimum pixels between labels, so text never collides. */
const MIN_LABEL_SPACING_PX = 72;

/**
 * Chooses the label interval for the current zoom, in frames.
 *
 * Picks the smallest interval from the ladder that keeps labels at least `MIN_LABEL_SPACING_PX`
 * apart. Falls back to whole seconds scaled up when even the coarsest entry is too dense, which
 * happens only at absurd zoom-out levels.
 */
export function chooseTickInterval(viewport: TimelineViewport): number {
  const rate = nominalRate(viewport.frameRate);

  for (const seconds of SECOND_INTERVALS) {
    const frames = Math.max(1, Math.round(seconds * rate));
    if (framesToPx(viewport, frames) >= MIN_LABEL_SPACING_PX) return frames;
  }

  // Beyond the ladder: keep doubling the largest entry until labels fit.
  let frames = Math.round(SECOND_INTERVALS[SECOND_INTERVALS.length - 1]! * rate);
  while (framesToPx(viewport, frames) < MIN_LABEL_SPACING_PX && frames < Number.MAX_SAFE_INTEGER / 4) {
    frames *= 2;
  }
  return frames;
}

/** Minimum pixels between minor ticks, below which the ruler reads as a grey band. */
const MIN_MINOR_SPACING_PX = 9;

/**
 * Subdivision counts to try, most subdivisions first.
 *
 * Only counts that divide the major interval evenly are usable, otherwise minor ticks would drift out
 * of alignment with the labelled ones. Ten and five come first because they land on whole seconds for
 * the 10 s and 5 s label intervals, which is what makes a ruler scannable.
 */
const SUBDIVISION_CANDIDATES: readonly number[] = [10, 5, 4, 2, 1];

/**
 * Chooses how finely to subdivide the major interval.
 *
 * Picks the most subdivisions that stay readable and divide evenly. Returns 1 when even halving would
 * be too dense, which suppresses minor ticks entirely.
 */
export function chooseSubdivisions(viewport: TimelineViewport, majorInterval: number): number {
  for (const count of SUBDIVISION_CANDIDATES) {
    if (majorInterval % count !== 0) continue;
    if (framesToPx(viewport, majorInterval / count) >= MIN_MINOR_SPACING_PX) return count;
  }
  return 1;
}

/**
 * Generates the visible ruler ticks.
 *
 * Minor ticks subdivide each major interval as finely as stays readable at the current zoom, so the
 * ruler gains detail as the user zooms in rather than switching abruptly between two densities.
 */
export function generateTicks(viewport: TimelineViewport): readonly RulerTick[] {
  if (viewport.widthPx <= 0) return [];

  const majorInterval = chooseTickInterval(viewport);
  const subdivisions = chooseSubdivisions(viewport, majorInterval);
  const step = Math.max(1, majorInterval / subdivisions);

  const visible = visibleSpan(viewport);
  const firstTick = Math.floor(visible.start / step) * step;
  const lastFrame = visible.start + visible.duration;
  const ticks: RulerTick[] = [];

  for (let frame = firstTick; frame <= lastFrame; frame += step) {
    if (frame < 0) continue;
    const major = frame % majorInterval === 0;
    ticks.push({
      frame: frameIndex(frame),
      px: frameToPx(viewport, frameIndex(frame)),
      major,
      ...(major ? { label: formatRulerLabel(frameIndex(frame), viewport.frameRate) } : {}),
    });
  }

  return ticks;
}

/**
 * Ruler label text.
 *
 * `MM:SS` at coarse zoom and `MM:SS.f` when a label interval is under a second, matching the
 * mockups' `00:12` style. Deliberately not full timecode: the ruler is for orientation, and the
 * transport readout carries the exact frame.
 */
export function formatRulerLabel(frame: FrameIndex, rate: FrameRate): string {
  const totalSeconds = framesToSecondsNumber(frame, rate);
  const sign = totalSeconds < 0 ? '-' : '';
  const absolute = Math.abs(totalSeconds);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor(absolute / 60) % 60;
  const seconds = Math.floor(absolute) % 60;
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));

  if (hours > 0) return `${sign}${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${sign}${pad(minutes)}:${pad(seconds)}`;
}

/** `4 f/px` style zoom readout for the toolbar. */
export function formatZoom(viewport: TimelineViewport): string {
  const value = viewport.framesPerPixel;
  if (value >= 1) return `${Math.round(value)} f/px`;
  return `${(1 / value).toFixed(0)} px/f`;
}

/** `29.97 fps · 3241 f · 12 clips` style status line. */
export function formatTimelineStatus(rate: FrameRate, totalFrames: number, clipCount: number): string {
  return `${displayFrameRate(rate)} fps · ${totalFrames} f · ${clipCount} clips`;
}

/**
 * How tall a collapsed lane is drawn.
 *
 * Enough for the clips on it to stay visible as coloured bars. A collapsed track that showed nothing
 * would be a row of empty space the user has to expand to find out whether it holds anything — which
 * is precisely the question collapsing is meant to stop them from having to ask about the other seven.
 */
export const COLLAPSED_TRACK_HEIGHT_PX = 22;

/**
 * How tall a track is drawn.
 *
 * One rule, in one place, because the answer is needed by five: the header, the lane, the clips inside
 * it, and the two running offsets that put the playhead and the drop indicator at the right y. A
 * collapsed track computed differently in any one of them would put the lanes and their headers out of
 * step, and everything below the mistake would be drawn at the wrong height.
 *
 * The track's own `height` is left untouched while it is collapsed, so expanding restores the height
 * the user chose rather than a default.
 */
export function laneHeight(track: { readonly height: number; readonly collapsed: boolean }): number {
  return track.collapsed ? COLLAPSED_TRACK_HEIGHT_PX : track.height;
}
