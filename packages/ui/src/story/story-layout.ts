import type { FrameRate, StoryBeat } from '@nos/core';
import { beatsInOrder, frameRateToNumber } from '@nos/core';
import { type TimelineViewport, frameToPx, framesToPx } from '../timeline/viewport.js';

/**
 * Where the beats of a story board are drawn.
 *
 * Issue #33. Placement uses the timeline's own viewport, so a beat and the clip it describes sit at
 * the same x — the whole reason the board runs on the project clock rather than on a list of cards.
 * A second set of frame-to-pixel maths here would drift from the timeline's the first time either
 * gained a scroll offset, and the two are meant to line up to the pixel.
 *
 * ## Why beats are packed into rows
 *
 * The model lets beats overlap on purpose: two ideas about the same three seconds is a normal state
 * for a plan. Drawn on one row they would paint over each other, and a beat entirely covered by
 * another would be *unreachable* — no pointer could ever land on it, so the only way to recover it
 * would be to edit the project file by hand. Packing gives every beat a rectangle of its own.
 *
 * Rows are assigned by first fit in time order, which is the arrangement that reads as a plan: a beat
 * stays on the top row unless something already there is in the way. Longest-first would pack denser
 * and would also make a beat jump rows when a *different* beat was lengthened.
 */

/** How a beat is drawn: which row it lands on, and the rectangle it occupies. */
export interface BeatBlock {
  readonly beat: StoryBeat;
  /** Zero-based row within the board. */
  readonly row: number;
  readonly leftPx: number;
  readonly widthPx: number;
}

/**
 * The narrowest a block ever draws.
 *
 * A one-frame beat zoomed out is a fraction of a pixel — invisible, and impossible to select or drag
 * back to a size where it could be. A minimum makes a short beat *inaccurate* at low zoom, which is
 * recoverable, instead of *lost*, which is not.
 */
export const MINIMUM_BLOCK_PX = 12;

/**
 * Clear space between two blocks in one row, so their edges read as two blocks rather than one.
 *
 * Taken off the drawn width, *not* added to what packing requires. Making it a packing rule is a
 * mistake worth naming, because it looks harmless and is not: consecutive beats — the ordinary case,
 * one shot after another — touch exactly, so a gutter demanded between them pushes every second beat
 * onto a row of its own and a plain sequential plan draws as a staircase.
 */
export const BLOCK_GUTTER_PX = 2;

export function layoutBeats(beats: readonly StoryBeat[], viewport: TimelineViewport): readonly BeatBlock[] {
  /*
   * Packing measures *pixels*, not frames. Two one-frame beats a frame apart do not overlap in time
   * and would share a row, yet both draw at the minimum width and would sit on top of each other —
   * which is the exact unreachability this exists to prevent.
   */
  const rowEnds: number[] = [];
  const blocks: BeatBlock[] = [];

  for (const beat of beatsInOrder(beats)) {
    const leftPx = frameToPx(viewport, beat.span.start);
    const spanPx = Math.max(MINIMUM_BLOCK_PX, framesToPx(viewport, beat.span.duration as number));

    let row = rowEnds.findIndex((end) => leftPx >= end);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(0);
    }
    // The space the beat *occupies*, which is what the next beat has to clear.
    rowEnds[row] = leftPx + spanPx;

    // The gutter comes out of the drawing, and never below the width a block can be grabbed at.
    blocks.push({ beat, row, leftPx, widthPx: Math.max(MINIMUM_BLOCK_PX, spanPx - BLOCK_GUTTER_PX) });
  }

  return blocks;
}

/**
 * How many rows the board needs.
 *
 * At least one, so an empty board still has a lane to drop the first beat into rather than collapsing
 * to a line with nothing to aim at.
 */
export function rowsUsed(blocks: readonly BeatBlock[]): number {
  return blocks.reduce((rows, block) => Math.max(rows, block.row + 1), 1);
}

/**
 * How wide the board's scrolling area is.
 *
 * The furthest block's right edge or the visible width, whichever is greater, plus a margin of empty
 * board past the end — a plan is extended by adding to the end of it, and a board that stopped exactly
 * at the last beat would leave nowhere to aim at.
 */
export function boardWidthPx(blocks: readonly BeatBlock[], viewport: TimelineViewport): number {
  const furthest = blocks.reduce((right, block) => Math.max(right, block.leftPx + block.widthPx), 0);
  return Math.max(viewport.widthPx, furthest + MINIMUM_BLOCK_PX * 8);
}

/**
 * How wide a beat of the default length should draw, in pixels.
 *
 * Not a taste: a block is a title and two lines of prose, and below roughly this it stops being
 * readable and becomes a coloured sliver. The board exists to be *read*, so the zoom follows from what
 * a block needs rather than the other way round.
 */
export const READABLE_BLOCK_PX = 180;

/**
 * The zoom a board opens at, for a project's frame rate.
 *
 * Derived rather than picked, because a constant is only right for one frame rate: the timeline's own
 * default of four frames per pixel draws a two-second beat fifteen pixels wide at 30 fps, which is
 * narrower than the minimum a beat can even be grabbed at. The board and the timeline measure the same
 * frames, but they are read at different distances — one is scanned for cuts, the other is read.
 */
export function defaultBoardZoom(frameRate: FrameRate, beatSeconds: number): number {
  const frames = Math.max(1, beatSeconds * frameRateToNumber(frameRate));
  return frames / READABLE_BLOCK_PX;
}
