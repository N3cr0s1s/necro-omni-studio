import { describe, expect, it } from 'vitest';
import { containedSize } from './Preview.js';

/**
 * Where the picture actually is inside the preview's box.
 *
 * Getting this wrong does not look broken. It places every mask point a few percent off, which
 * reads as the segmentation engine being inaccurate — so the arithmetic is checked against the
 * cases that differ rather than assumed from the one that does not.
 */
describe('fitting a picture into a box', () => {
  it('fills a box of the same shape exactly', () => {
    expect(containedSize(1600, 900, 1920, 1080)).toEqual({ width: 1600, height: 900 });
  });

  it('letterboxes a wide picture in a tall box', () => {
    // Width-limited: bars above and below.
    expect(containedSize(800, 800, 1920, 1080)).toEqual({ width: 800, height: 450 });
  });

  it('pillarboxes a tall picture in a wide box', () => {
    // Height-limited: bars left and right. The case a vertical clip in a 16:9 project produces, and
    // the one an aspect-blind overlay gets wrong by the entire width of the bars.
    expect(containedSize(800, 800, 1080, 1920)).toEqual({ width: 450, height: 800 });
  });

  it('scales up as well as down, since a small frame is centred rather than pinned', () => {
    expect(containedSize(1000, 1000, 100, 50)).toEqual({ width: 1000, height: 500 });
  });

  it('falls back to the box for a resolution that cannot be fitted', () => {
    // A project with a zero dimension is not reachable through the UI, and dividing by it would
    // place every point at infinity rather than merely in the wrong spot.
    expect(containedSize(800, 600, 0, 0)).toEqual({ width: 800, height: 600 });
  });
});
