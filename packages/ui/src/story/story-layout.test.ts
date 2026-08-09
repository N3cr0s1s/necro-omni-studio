import { describe, expect, it } from 'vitest';
import { FRAME_RATES, type StoryBeat, frameIndex, spanFromBounds, storyBeatId } from '@nos/core';
import { createViewport } from '../timeline/viewport.js';
import {
  BLOCK_GUTTER_PX,
  MINIMUM_BLOCK_PX,
  READABLE_BLOCK_PX,
  boardWidthPx,
  defaultBoardZoom,
  layoutBeats,
  rowsUsed,
} from './story-layout.js';

/**
 * Where the beats of a story board are drawn, per issue #33.
 */

const beat = (id: string, from: number, to: number): StoryBeat => ({
  id: storyBeatId(id),
  span: spanFromBounds(frameIndex(from), frameIndex(to)),
  title: '',
  notes: '',
  references: [],
});

/** One frame per pixel, so every expectation below is readable as frames. */
const viewport = createViewport({ framesPerPixel: 1, widthPx: 800, frameRate: FRAME_RATES.WEB_30 });

describe('placing a beat', () => {
  it('puts it where its frames are, on the timeline’s own scale', () => {
    // The point of the board running on the project clock: a beat sits at the same x as the clip it
    // describes.
    const [block] = layoutBeats([beat('a', 100, 250)], viewport);
    expect(block?.leftPx).toBe(100);
    // The span, less the gutter that keeps it visually apart from whatever comes next.
    expect(block?.widthPx).toBe(150 - BLOCK_GUTTER_PX);
  });

  it('follows the viewport’s zoom', () => {
    const zoomed = createViewport({ framesPerPixel: 2, widthPx: 800, frameRate: FRAME_RATES.WEB_30 });
    const [block] = layoutBeats([beat('a', 100, 250)], zoomed);
    expect(block?.leftPx).toBe(50);
    expect(block?.widthPx).toBe(75 - BLOCK_GUTTER_PX);
  });

  it('never draws narrower than a beat can be grabbed at', () => {
    // A one-frame beat zoomed out is a fraction of a pixel: invisible, and impossible to select or
    // drag back to a size where it could be.
    const far = createViewport({ framesPerPixel: 256, widthPx: 800, frameRate: FRAME_RATES.WEB_30 });
    expect(layoutBeats([beat('a', 0, 1)], far)[0]?.widthPx).toBe(MINIMUM_BLOCK_PX);
  });
});

describe('packing overlapping beats', () => {
  it('keeps consecutive beats on one row', () => {
    // One shot after another is the ordinary case: they touch exactly, and a gutter *demanded*
    // between them would push every second beat onto its own row and draw a plain plan as a
    // staircase. The gutter is taken off the drawing instead.
    const blocks = layoutBeats([beat('a', 0, 100), beat('b', 100, 200), beat('c', 200, 300)], viewport);
    expect(blocks.map((block) => block.row)).toEqual([0, 0, 0]);
  });

  it('keeps beats that do not overlap on one row', () => {
    const blocks = layoutBeats([beat('a', 0, 100), beat('b', 200, 300)], viewport);
    expect(blocks.map((block) => block.row)).toEqual([0, 0]);
  });

  it('gives an overlapping beat a row of its own', () => {
    // Two ideas about the same three seconds is a normal state for a plan.
    const blocks = layoutBeats([beat('a', 0, 100), beat('b', 50, 150)], viewport);
    expect(blocks.map((block) => block.row)).toEqual([0, 1]);
  });

  it('never leaves a beat with no rectangle of its own', () => {
    // A beat entirely covered by another could not be reached by any pointer, and the only way back
    // would be editing the project file by hand.
    const blocks = layoutBeats([beat('outer', 0, 300), beat('inner', 100, 200)], viewport);
    expect(new Set(blocks.map((block) => block.row)).size).toBe(2);
  });

  it('reuses a row once it is free again', () => {
    // First fit, not one row per beat: three beats where only two ever overlap need two rows.
    const blocks = layoutBeats([beat('a', 0, 100), beat('b', 50, 150), beat('c', 200, 300)], viewport);
    expect(blocks.map((block) => block.row)).toEqual([0, 1, 0]);
  });

  it('separates two short beats that share no frames but would share pixels', () => {
    // Packing measures pixels, not frames. These do not overlap in time, yet both draw at the minimum
    // width — on one row the second would sit on top of the first.
    const far = createViewport({ framesPerPixel: 256, widthPx: 800, frameRate: FRAME_RATES.WEB_30 });
    const blocks = layoutBeats([beat('a', 0, 1), beat('b', 1, 2)], far);
    expect(blocks.map((block) => block.row)).toEqual([0, 1]);
  });

  it('orders by time regardless of the order given', () => {
    const blocks = layoutBeats([beat('late', 200, 300), beat('early', 0, 100)], viewport);
    expect(blocks.map((block) => block.beat.id)).toEqual(['early', 'late']);
  });
});

describe('the size of the board', () => {
  it('is one row when there is nothing on it, so there is somewhere to drop the first beat', () => {
    expect(rowsUsed([])).toBe(1);
  });

  it('counts the rows the packing used', () => {
    expect(rowsUsed(layoutBeats([beat('a', 0, 100), beat('b', 50, 150)], viewport))).toBe(2);
  });

  it('is at least as wide as what is visible', () => {
    expect(boardWidthPx([], viewport)).toBe(800);
  });

  it('leaves board past the last beat, because a plan is extended at its end', () => {
    const blocks = layoutBeats([beat('a', 0, 2000)], viewport);
    expect(boardWidthPx(blocks, viewport)).toBeGreaterThan(2000);
  });
});

describe('the zoom a board opens at', () => {
  it('draws a default-length beat wide enough to read', () => {
    const zoom = defaultBoardZoom(FRAME_RATES.WEB_30, 2);
    const opened = createViewport({ framesPerPixel: zoom, widthPx: 800, frameRate: FRAME_RATES.WEB_30 });
    const [block] = layoutBeats([beat('a', 0, 60)], opened);
    expect(block?.widthPx).toBe(READABLE_BLOCK_PX - BLOCK_GUTTER_PX);
  });

  it('is the same width at any frame rate, which is why it is derived and not a constant', () => {
    // A fixed frames-per-pixel is only right for one rate: at 60 fps the same number draws every beat
    // half as wide.
    const at60 = createViewport({
      framesPerPixel: defaultBoardZoom(FRAME_RATES.WEB_60, 2),
      widthPx: 800,
      frameRate: FRAME_RATES.WEB_60,
    });
    expect(layoutBeats([beat('a', 0, 120)], at60)[0]?.widthPx).toBe(READABLE_BLOCK_PX - BLOCK_GUTTER_PX);
  });

  it('is far finer than the timeline’s own default, which draws a beat too narrow to grab', () => {
    // The timeline opens at four frames per pixel, which is fifteen pixels for a two-second beat at
    // 30 fps — narrower than the minimum a block can even be selected at.
    expect(defaultBoardZoom(FRAME_RATES.WEB_30, 2)).toBeLessThan(4);
  });
});
