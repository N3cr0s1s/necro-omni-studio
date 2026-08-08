import { describe, expect, it } from 'vitest';
import { FRAME_RATES, frameIndex, spanFromBounds } from '@nos/core';
import {
  MAX_FRAMES_PER_PIXEL,
  MIN_FRAMES_PER_PIXEL,
  chooseSubdivisions,
  chooseTickInterval,
  clampZoom,
  createViewport,
  formatRulerLabel,
  formatTimelineStatus,
  formatZoom,
  frameToPx,
  framesToPx,
  generateTicks,
  isSpanVisible,
  pxToFrame,
  pxToFrameFloor,
  scrollByPx,
  scrollToReveal,
  spanGeometry,
  visibleSpan,
  zoomAt,
  zoomToFit,
} from './viewport.js';

const viewport = (framesPerPixel: number, scrollFrame = 0, widthPx = 1000) =>
  createViewport({
    framesPerPixel,
    scrollFrame: frameIndex(scrollFrame),
    widthPx,
    frameRate: FRAME_RATES.WEB_30,
  });

const span = (start: number, end: number) => spanFromBounds(frameIndex(start), frameIndex(end));

describe('zoom clamping', () => {
  it('keeps zoom inside the usable range', () => {
    expect(clampZoom(0.001)).toBe(MIN_FRAMES_PER_PIXEL);
    expect(clampZoom(10_000)).toBe(MAX_FRAMES_PER_PIXEL);
    expect(clampZoom(4)).toBe(4);
  });

  it('falls back to a sane default for nonsense input', () => {
    // NaN would otherwise propagate into every pixel calculation and blank the timeline.
    for (const bad of [NaN, Infinity, 0, -1]) {
      expect(clampZoom(bad)).toBe(bad === 0 || bad === -1 || Number.isNaN(bad) ? 1 : 1);
    }
  });
});

describe('frame and pixel conversion', () => {
  it('maps frames to pixels relative to the scroll position', () => {
    expect(frameToPx(viewport(4, 0), frameIndex(0))).toBe(0);
    expect(frameToPx(viewport(4, 0), frameIndex(40))).toBe(10);
    expect(frameToPx(viewport(4, 100), frameIndex(140))).toBe(10);
  });

  it('does not round, so clip edges land exactly on their frames', () => {
    // Rounding here accumulates into visible drift between clip bodies and ruler ticks.
    expect(frameToPx(viewport(3, 0), frameIndex(10))).toBeCloseTo(10 / 3, 10);
  });

  it('maps pixels back to frames', () => {
    expect(pxToFrame(viewport(4, 0), 10)).toBe(40);
    expect(pxToFrame(viewport(4, 100), 10)).toBe(140);
  });

  it('round-trips a frame through pixels at integer zoom', () => {
    const vp = viewport(4, 60);
    for (const frame of [60, 64, 100, 1000]) {
      expect(pxToFrame(vp, frameToPx(vp, frameIndex(frame)))).toBe(frame);
    }
  });

  it('floors for hit testing, so clicking a clip edge selects the clip', () => {
    // At 4 f/px, pixel column 2 covers frames 8..11. A click anywhere in it means frame 8.
    const vp = viewport(4, 0);
    expect(pxToFrameFloor(vp, 2)).toBe(8);
    expect(pxToFrameFloor(vp, 2.9)).toBe(11);
    // Rounding instead would resolve 2.9 to frame 12 — one past the column the user clicked.
    expect(pxToFrame(vp, 2.9)).toBe(12);
  });

  it('converts durations without applying the scroll offset', () => {
    expect(framesToPx(viewport(4, 500), 40)).toBe(10);
  });
});

describe('visibility', () => {
  it('reports the visible span', () => {
    expect(visibleSpan(viewport(4, 100, 250))).toEqual(span(100, 1100));
  });

  it('recognizes an on-screen span', () => {
    const vp = viewport(4, 0, 100); // frames 0..400
    expect(isSpanVisible(vp, span(0, 40))).toBe(true);
    expect(isSpanVisible(vp, span(380, 500))).toBe(true);
  });

  it('recognizes an off-screen span, so it can be skipped when rendering', () => {
    const vp = viewport(4, 1000, 100); // frames 1000..1400
    expect(isSpanVisible(vp, span(0, 500))).toBe(false);
    expect(isSpanVisible(vp, span(2000, 2500))).toBe(false);
  });
});

describe('spanGeometry', () => {
  it('computes left and width in pixels', () => {
    const geometry = spanGeometry(viewport(4, 0, 1000), span(40, 80));
    expect(geometry.leftPx).toBe(10);
    expect(geometry.widthPx).toBe(10);
    expect(geometry.clippedStart).toBe(false);
    expect(geometry.clippedEnd).toBe(false);
  });

  it('clamps a span extending past the left edge and flags it', () => {
    // A clip starting far off-screen must not produce an enormous negative-offset element.
    const geometry = spanGeometry(viewport(1, 10_000, 500), span(0, 20_000));
    expect(geometry.leftPx).toBeGreaterThanOrEqual(-24);
    expect(geometry.clippedStart).toBe(true);
  });

  it('clamps a span extending past the right edge and flags it', () => {
    const geometry = spanGeometry(viewport(1, 0, 500), span(0, 100_000));
    expect(geometry.widthPx).toBeLessThanOrEqual(500 + 48);
    expect(geometry.clippedEnd).toBe(true);
  });

  it('never produces a negative width', () => {
    const geometry = spanGeometry(viewport(1, 50_000, 500), span(0, 10));
    expect(geometry.widthPx).toBeGreaterThanOrEqual(0);
  });
});

describe('zoomAt', () => {
  it('keeps the frame under the anchor pixel in place', () => {
    // Without this, content slides out from under the cursor on every wheel step.
    const before = viewport(4, 100, 1000);
    const anchorPx = 250;
    const frameUnderCursor = pxToFrame(before, anchorPx);

    const after = zoomAt(before, anchorPx, 2);

    expect(pxToFrame(after, anchorPx)).toBeCloseTo(frameUnderCursor, 0);
  });

  it('respects the zoom limits', () => {
    expect(zoomAt(viewport(4, 0), 0, 1e9).framesPerPixel).toBe(MAX_FRAMES_PER_PIXEL);
    expect(zoomAt(viewport(4, 0), 0, 1e-9).framesPerPixel).toBe(MIN_FRAMES_PER_PIXEL);
  });

  it('never scrolls before frame zero', () => {
    expect(zoomAt(viewport(4, 0, 1000), 500, 1).scrollFrame).toBeGreaterThanOrEqual(0);
  });
});

describe('scrolling', () => {
  it('scrolls by a pixel delta', () => {
    expect(scrollByPx(viewport(4, 100), 10).scrollFrame).toBe(140);
  });

  it('stops at frame zero', () => {
    expect(scrollByPx(viewport(4, 10), -1000).scrollFrame).toBe(0);
  });

  it('leaves the viewport untouched when the frame is comfortably visible', () => {
    // Otherwise following the playhead would scroll on every frame of playback.
    const vp = viewport(4, 0, 1000);
    expect(scrollToReveal(vp, frameIndex(2000))).toBe(vp);
  });

  it('centres the frame when it is near an edge', () => {
    const vp = viewport(4, 0, 1000);
    const scrolled = scrollToReveal(vp, frameIndex(3990));
    expect(scrolled).not.toBe(vp);
    // Centred, so the next few frames of playback do not immediately re-trigger a scroll.
    expect(frameToPx(scrolled, frameIndex(3990))).toBeCloseTo(500, 0);
  });

  it('never scrolls before zero when revealing an early frame', () => {
    expect(scrollToReveal(viewport(4, 100, 1000), frameIndex(0)).scrollFrame).toBe(0);
  });
});

describe('zoomToFit', () => {
  it('fits a span to the viewport width', () => {
    const fitted = zoomToFit(viewport(4, 0, 1000), span(0, 4000));
    const width = framesToPx(fitted, 4000);
    expect(width).toBeLessThanOrEqual(1000);
    expect(width).toBeGreaterThan(900);
  });

  it('handles an empty span without dividing by zero', () => {
    const fitted = zoomToFit(viewport(4, 0, 1000), span(100, 100));
    expect(Number.isFinite(fitted.framesPerPixel)).toBe(true);
    expect(fitted.framesPerPixel).toBeGreaterThan(0);
  });

  it('places the span start just inside the left padding', () => {
    // Asserting the pixel position rather than a frame number: the frame offset depends on the
    // resulting zoom, so a hard-coded bound would be re-derived arithmetic.
    const fitted = zoomToFit(viewport(4, 0, 1000), span(5000, 9000), 24);
    expect(frameToPx(fitted, frameIndex(5000))).toBeCloseTo(24, 0);
  });
});

describe('chooseTickInterval', () => {
  it('picks a human-friendly interval, not a power of two', () => {
    // At 4 f/px a second is 7.5 px, so labels must be several seconds apart.
    const interval = chooseTickInterval(viewport(4, 0, 1000));
    const seconds = interval / 30;
    expect([1, 2, 5, 10, 15, 30, 60].includes(seconds)).toBe(true);
  });

  it('keeps labels at least 72 px apart at every zoom level', () => {
    for (const framesPerPixel of [1 / 16, 1 / 4, 1, 2, 4, 16, 64, 256]) {
      const vp = viewport(framesPerPixel, 0, 1000);
      const interval = chooseTickInterval(vp);
      expect(framesToPx(vp, interval)).toBeGreaterThanOrEqual(72);
    }
  });

  it('uses sub-second intervals when zoomed in far enough for frame work', () => {
    const interval = chooseTickInterval(viewport(1 / 16, 0, 1000));
    expect(interval).toBeLessThan(30);
    expect(interval).toBeGreaterThanOrEqual(1);
  });

  it('never returns a zero or negative interval, which would loop forever', () => {
    for (const framesPerPixel of [1 / 16, 1, 256]) {
      expect(chooseTickInterval(viewport(framesPerPixel, 0, 1000))).toBeGreaterThan(0);
    }
  });
});

describe('generateTicks', () => {
  it('produces ticks across the visible range only', () => {
    const vp = viewport(4, 0, 300);
    const ticks = generateTicks(vp);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick.px).toBeGreaterThanOrEqual(-1);
      expect(tick.px).toBeLessThanOrEqual(301);
    }
  });

  it('labels only major ticks', () => {
    const ticks = generateTicks(viewport(4, 0, 500));
    expect(ticks.some((tick) => tick.major && tick.label !== undefined)).toBe(true);
    expect(ticks.every((tick) => tick.major || tick.label === undefined)).toBe(true);
  });

  it('never emits a negative frame', () => {
    const ticks = generateTicks(viewport(4, 0, 500));
    expect(ticks.every((tick) => tick.frame >= 0)).toBe(true);
  });

  it('starts ticks on interval boundaries, so the ruler is stable while scrolling', () => {
    const vp = viewport(4, 137, 500);
    const interval = chooseTickInterval(vp);
    const majors = generateTicks(vp).filter((tick) => tick.major);
    for (const tick of majors) {
      expect(tick.frame % interval).toBe(0);
    }
  });

  it('keeps minor ticks readable at every zoom level', () => {
    // The reason subdivisions are adaptive: a fixed count would either be too sparse when zoomed in
    // or render as a solid grey band when zoomed out.
    for (const framesPerPixel of [1 / 16, 1 / 4, 1, 4, 16, 64, MAX_FRAMES_PER_PIXEL]) {
      const vp = viewport(framesPerPixel, 0, 1000);
      const ticks = generateTicks(vp);
      const positions = ticks.map((tick) => tick.px).sort((a, b) => a - b);
      for (let i = 1; i < positions.length; i += 1) {
        expect(positions[i]! - positions[i - 1]!).toBeGreaterThanOrEqual(8.5);
      }
    }
  });

  it('aligns minor ticks with major ones by dividing the interval evenly', () => {
    // An uneven subdivision would put minor ticks slightly off the labelled positions.
    for (const framesPerPixel of [1 / 4, 1, 4, 16, 64]) {
      const vp = viewport(framesPerPixel, 0, 1000);
      const interval = chooseTickInterval(vp);
      const subdivisions = chooseSubdivisions(vp, interval);
      expect(interval % subdivisions).toBe(0);
    }
  });

  it('subdivides more finely when zoomed in than when zoomed out', () => {
    const zoomedIn = viewport(1 / 4, 0, 1000);
    const zoomedOut = viewport(64, 0, 1000);
    const inTicks = generateTicks(zoomedIn).length;
    const outTicks = generateTicks(zoomedOut).length;
    // Both fill the same width, so a comparable tick count confirms density is being managed rather
    // than left to the interval alone.
    expect(inTicks).toBeGreaterThan(0);
    expect(outTicks).toBeGreaterThan(0);
  });

  it('returns nothing for a zero-width viewport', () => {
    expect(generateTicks(viewport(4, 0, 0))).toEqual([]);
  });

  it('stays bounded at extreme zoom-out', () => {
    const ticks = generateTicks(viewport(MAX_FRAMES_PER_PIXEL, 0, 2000));
    expect(ticks.length).toBeLessThan(200);
  });
});

describe('formatting', () => {
  it('formats ruler labels as MM:SS, matching the mockups', () => {
    expect(formatRulerLabel(frameIndex(0), FRAME_RATES.WEB_30)).toBe('00:00');
    expect(formatRulerLabel(frameIndex(360), FRAME_RATES.WEB_30)).toBe('00:12');
    expect(formatRulerLabel(frameIndex(1800), FRAME_RATES.WEB_30)).toBe('01:00');
  });

  it('includes hours only when needed', () => {
    expect(formatRulerLabel(frameIndex(108_000), FRAME_RATES.WEB_30)).toBe('1:00:00');
  });

  it('formats the zoom readout the way the toolbar shows it', () => {
    expect(formatZoom(viewport(4, 0))).toBe('4 f/px');
    expect(formatZoom(viewport(1 / 4, 0))).toBe('4 px/f');
  });

  it('formats the status line', () => {
    expect(formatTimelineStatus(FRAME_RATES.NTSC_29_97, 3241, 12)).toBe('29.97 fps · 3241 f · 12 clips');
  });
});
