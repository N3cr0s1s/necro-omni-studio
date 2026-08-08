import { describe, expect, it } from 'vitest';
import { fittedStrip, spanningStrip } from './clip-strip.js';

/**
 * Placing an asset-wide strip against the range one clip shows.
 *
 * The arithmetic is small and the consequence of getting it wrong is not: a filmstrip offset by a
 * second puts the wrong picture under the playhead, and an editor who trusts it cuts in the wrong
 * place. These are the cases that arithmetic has to survive.
 */

describe('a strip drawn for one clip', () => {
  it('covers exactly the clip', () => {
    expect(fittedStrip('blob:x')).toEqual({ url: 'blob:x', widths: 1, offset: 0 });
  });
});

describe('a strip covering a whole asset', () => {
  it('is stretched by however much of the source the clip shows', () => {
    // Ten seconds of source drawn across a clip showing two: the image has to be five clips wide.
    const strip = spanningStrip('file:x', { sourceSeconds: 10, startSeconds: 0, shownSeconds: 2 });
    expect(strip.widths).toBeCloseTo(5);
    expect(strip.offset).toBeCloseTo(0);
  });

  it('is pushed left by the clip’s in-point', () => {
    // Starting four seconds in, at two seconds per clip width, is two clip widths of image to hide.
    const strip = spanningStrip('file:x', { sourceSeconds: 10, startSeconds: 4, shownSeconds: 2 });
    expect(strip.offset).toBeCloseTo(2);
  });

  it('puts the clip’s midpoint over the same moment of the source', () => {
    // The property that matters, stated directly: the fraction of the image under the clip's centre
    // must be the fraction of the source that moment sits at.
    const strip = spanningStrip('file:x', { sourceSeconds: 20, startSeconds: 5, shownSeconds: 4 });

    // In clip widths from the image's left edge to the clip's centre, over the image's total width.
    const fraction = (strip.offset + 0.5) / strip.widths;
    expect(fraction).toBeCloseTo((5 + 2) / 20);
  });

  it('fills the clip when it shows the whole source', () => {
    const strip = spanningStrip('file:x', { sourceSeconds: 3, startSeconds: 0, shownSeconds: 3 });
    expect(strip).toEqual({ url: 'file:x', widths: 1, offset: 0 });
  });

  it('handles a clip shown slower than its source', () => {
    // Half speed: two seconds on the timeline show one second of source, so the caller passes the
    // source seconds and the strip must not double-count the retime.
    const strip = spanningStrip('file:x', { sourceSeconds: 8, startSeconds: 0, shownSeconds: 1 });
    expect(strip.widths).toBeCloseTo(8);
  });
});

describe('degenerate spans', () => {
  it('does not divide by a zero-length clip', () => {
    const strip = spanningStrip('file:x', { sourceSeconds: 10, startSeconds: 0, shownSeconds: 0 });
    expect(Number.isFinite(strip.widths)).toBe(true);
    expect(strip.widths).toBe(1);
  });

  it('does not stretch by an unknown source length', () => {
    const strip = spanningStrip('file:x', { sourceSeconds: 0, startSeconds: 2, shownSeconds: 4 });
    expect(strip).toEqual({ url: 'file:x', widths: 1, offset: 0 });
  });
});
