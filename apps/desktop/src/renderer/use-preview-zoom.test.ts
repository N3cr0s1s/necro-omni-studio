import { describe, expect, it } from 'vitest';
import { ZOOM_RANGE, clampPan, clampZoom, describeZoom } from './use-preview-zoom.js';

/**
 * Looking closer at the frame.
 *
 * The preview letterboxes into whatever room the panel has, so the frame is almost never at its own
 * size — and at two thirds you cannot judge a mask edge or a title's kerning, which is most of what
 * this application is for.
 */

const BOX = { width: 800, height: 450 };

describe('how far the zoom goes', () => {
  it('does not go below fit, because there is nothing there', () => {
    // Zooming out past fit would letterbox an already letterboxed picture: more of nothing.
    expect(clampZoom(0.5)).toBe(ZOOM_RANGE.min);
  });

  it('stops where a pixel is already countable', () => {
    expect(clampZoom(100)).toBe(ZOOM_RANGE.max);
  });

  it('treats NaN as fit rather than propagating it', () => {
    // `NaN` has no order, so the clamp would pass it straight through — and it reaches CSS as an
    // invalid transform, which makes the picture vanish with nothing logged anywhere.
    expect(clampZoom(Number.NaN)).toBe(ZOOM_RANGE.min);
  });

  it('clamps infinity like any other number that is too large', () => {
    // Ordered, unlike NaN, so it needs no special case — and pretending it did would hide the one
    // value that does.
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_RANGE.max);
  });
});

describe('keeping the picture within reach', () => {
  it('allows no pan at all when the picture fits', () => {
    // There is no overhang, so every offset would move the frame away from the panel it fills.
    expect(clampPan({ x: 300, y: 300 }, 1, BOX)).toEqual({ x: 0, y: 0 });
  });

  it('allows exactly the overhang once zoomed', () => {
    // At 2× the picture is twice the box, so half the excess in each direction is where its edge
    // meets the panel's — pan further and the user is looking at empty space.
    expect(clampPan({ x: 1000, y: 1000 }, 2, BOX)).toEqual({ x: 400, y: 225 });
    expect(clampPan({ x: -1000, y: -1000 }, 2, BOX)).toEqual({ x: -400, y: -225 });
  });

  it('leaves a pan inside the bound untouched', () => {
    expect(clampPan({ x: 40, y: -20 }, 2, BOX)).toEqual({ x: 40, y: -20 });
  });

  it('re-centres when the zoom comes back to fit', () => {
    // Which is why zooming out needs no separate "and centre it" step.
    expect(clampPan({ x: 400, y: 225 }, 1, BOX)).toEqual({ x: 0, y: 0 });
  });
});

describe('what the readout says', () => {
  it('names the fit ratio as a fit', () => {
    // Without the word, a user who has never touched the zoom reads 68% as something they did.
    expect(describeZoom(1306, 1920, 1)).toBe('fit · 68%');
  });

  it('drops the word once it has been asked for', () => {
    expect(describeZoom(1306, 1920, 2)).toBe('136%');
  });

  it('says nothing before the picture has been measured', () => {
    // `0%` would be a claim about a frame that has not been laid out.
    expect(describeZoom(undefined, 1920, 1)).toBeUndefined();
    expect(describeZoom(0, 1920, 1)).toBeUndefined();
  });

  it('says nothing for a project with no width, rather than dividing by it', () => {
    expect(describeZoom(1306, 0, 1)).toBeUndefined();
  });
});
