import { describe, expect, it } from 'vitest';
import { REVIEW_SHORT_EDGE, exportResolution, reviewResolution } from './review-resolution.js';

/**
 * The size a review copy renders at.
 *
 * `useProxyResolution` was declared, defaulted, and warned about with a badge while nothing set it and
 * nothing acted on it. The rule lives here so the dialog's estimate and the renderer cannot disagree
 * about what a review copy is — an estimate computed from one size and a file produced at another is
 * worse than no estimate at all.
 */

describe('scaling to the review size', () => {
  it('constrains the short edge, so 4K and 1080p land on the same height', () => {
    // Halving is the obvious rule and the wrong one: half of 4K is still 1080p.
    expect(reviewResolution({ width: 3840, height: 2160 })).toEqual({ width: 960, height: 540 });
    expect(reviewResolution({ width: 1920, height: 1080 })).toEqual({ width: 960, height: 540 });
  });

  it('treats portrait the same way, which a width-based rule does not', () => {
    expect(reviewResolution({ width: 1080, height: 1920 })).toEqual({ width: 540, height: 960 });
  });

  it('leaves something already small alone rather than upscaling it', () => {
    // A "smaller" copy that is larger costs more to encode and looks worse.
    expect(reviewResolution({ width: 640, height: 360 })).toEqual({ width: 640, height: 360 });
  });

  it('returns even dimensions, because yuv420p subsamples chroma by two', () => {
    // An odd dimension is rejected by the encoder or silently padded, and padding shifts the picture
    // half a pixel against the preview — a WYSIWYG failure nobody looks for in a review copy.
    const scaled = reviewResolution({ width: 1999, height: 1001 });
    expect(scaled.width % 2).toBe(0);
    expect(scaled.height % 2).toBe(0);
  });

  it('never collapses to zero', () => {
    expect(reviewResolution({ width: 1, height: 1 })).toEqual({ width: 2, height: 2 });
  });

  it('respects a caller´s own short edge', () => {
    expect(reviewResolution({ width: 1920, height: 1080 }, 270)).toEqual({ width: 480, height: 270 });
  });

  it('uses the same short edge as the editing proxies by default', () => {
    expect(reviewResolution({ width: 1920, height: 1080 }).height).toBe(REVIEW_SHORT_EDGE);
  });
});

describe('what an export actually renders at', () => {
  it('is the full resolution unless a review copy was asked for', () => {
    // Never the default: an export that quietly delivered a proxy would be a serious failure.
    expect(exportResolution({ width: 1920, height: 1080 }, false)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('is the review size when it was', () => {
    expect(exportResolution({ width: 1920, height: 1080 }, true)).toEqual({ width: 960, height: 540 });
  });

  it('evens a full resolution too, since the encoder´s rule does not care why', () => {
    expect(exportResolution({ width: 1921, height: 1081 }, false)).toEqual({
      width: 1920,
      height: 1080,
    });
  });
});
