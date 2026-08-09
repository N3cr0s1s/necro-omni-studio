import { describe, expect, it } from 'vitest';
import { frameIndex } from '../time/frame-time.js';
import { keyframeId } from './ids.js';
import {
  type Easing,
  type Keyframe,
  DEFAULT_BEZIER,
  animatedNumber,
  applyEasing,
  bezierEase,
  evaluateAt,
  evaluateBezier,
  freezeAt,
  isAnimated,
  isEasing,
  keyframeCount,
  scaleKeyframes,
  shiftKeyframes,
  staticNumber,
} from './params.js';

let counter = 0;
function kf(frame: number, value: number, ease: Easing = 'linear'): Keyframe {
  counter += 1;
  return { id: keyframeId(`kf_${counter}`), frame: frameIndex(frame), value, ease };
}

describe('applyEasing', () => {
  it('pins both ends of every curve, so a segment always reaches its target', () => {
    for (const ease of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      expect(applyEasing(ease, 0)).toBeCloseTo(0, 10);
      expect(applyEasing(ease, 1)).toBeCloseTo(1, 10);
    }
  });

  it('is the identity for linear', () => {
    expect(applyEasing('linear', 0.25)).toBeCloseTo(0.25, 10);
  });

  it('starts slow for ease-in and fast for ease-out', () => {
    expect(applyEasing('ease-in', 0.5)).toBeLessThan(0.5);
    expect(applyEasing('ease-out', 0.5)).toBeGreaterThan(0.5);
  });

  it('is symmetric about the midpoint for ease-in-out', () => {
    expect(applyEasing('ease-in-out', 0.5)).toBeCloseTo(0.5, 10);
    for (const t of [0.1, 0.25, 0.4]) {
      expect(applyEasing('ease-in-out', t)).toBeCloseTo(1 - applyEasing('ease-in-out', 1 - t), 10);
    }
  });

  it('is monotonically non-decreasing, so no parameter ever moves backwards', () => {
    for (const ease of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      let previous = -Infinity;
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const current = applyEasing(ease, Math.min(t, 1));
        expect(current).toBeGreaterThanOrEqual(previous - 1e-12);
        previous = current;
      }
    }
  });

  it('holds at the outgoing value for the whole segment', () => {
    expect(applyEasing('hold', 0)).toBe(0);
    expect(applyEasing('hold', 0.5)).toBe(0);
    expect(applyEasing('hold', 0.999)).toBe(0);
  });

  it('recognizes the five named shapes and the hand-drawn curve, and nothing else', () => {
    for (const ease of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier']) {
      expect(isEasing(ease)).toBe(true);
    }
    expect(isEasing('spring')).toBe(false);
    expect(isEasing('')).toBe(false);
  });
});

describe('construction', () => {
  it('reports a static parameter as not animated', () => {
    const param = staticNumber(0.5);
    expect(isAnimated(param)).toBe(false);
    expect(keyframeCount(param)).toBe(0);
  });

  it('sorts keyframes by position so the evaluator can binary-search', () => {
    const param = animatedNumber([kf(30, 1), kf(0, 0), kf(15, 0.5)]);
    expect(isAnimated(param) && param.keyframes.map((k) => k.frame)).toEqual([0, 15, 30]);
  });

  it('lets the last keyframe on a frame win, so a drag onto an occupied frame replaces', () => {
    const param = animatedNumber([kf(10, 1), kf(10, 2)]);
    expect(keyframeCount(param)).toBe(1);
    expect(evaluateAt(param, frameIndex(10))).toBe(2);
  });
});

describe('evaluateAt', () => {
  it('returns the constant for a static parameter at any frame', () => {
    const param = staticNumber(0.15);
    expect(evaluateAt(param, frameIndex(0))).toBe(0.15);
    expect(evaluateAt(param, frameIndex(9999))).toBe(0.15);
  });

  it('interpolates linearly between two keyframes', () => {
    const param = animatedNumber([kf(0, 0), kf(10, 1)]);
    expect(evaluateAt(param, frameIndex(0))).toBeCloseTo(0, 10);
    expect(evaluateAt(param, frameIndex(5))).toBeCloseTo(0.5, 10);
    expect(evaluateAt(param, frameIndex(10))).toBeCloseTo(1, 10);
  });

  it('holds the nearest value outside the range instead of extrapolating', () => {
    // Extrapolation would push opacity past 1 when a clip outlives its animation.
    const param = animatedNumber([kf(10, 0.2), kf(20, 0.8)]);
    expect(evaluateAt(param, frameIndex(0))).toBe(0.2);
    expect(evaluateAt(param, frameIndex(9))).toBe(0.2);
    expect(evaluateAt(param, frameIndex(21))).toBe(0.8);
    expect(evaluateAt(param, frameIndex(10_000))).toBe(0.8);
  });

  it('applies the easing of the keyframe the segment leaves', () => {
    const easeIn = animatedNumber([kf(0, 0, 'ease-in'), kf(10, 1, 'linear')]);
    const linear = animatedNumber([kf(0, 0, 'linear'), kf(10, 1, 'linear')]);
    expect(evaluateAt(easeIn, frameIndex(5))).toBeLessThan(evaluateAt(linear, frameIndex(5)));
  });

  it('ignores the last keyframe easing, which governs no segment', () => {
    const a = animatedNumber([kf(0, 0, 'linear'), kf(10, 1, 'ease-in')]);
    const b = animatedNumber([kf(0, 0, 'linear'), kf(10, 1, 'hold')]);
    expect(evaluateAt(a, frameIndex(5))).toBe(evaluateAt(b, frameIndex(5)));
  });

  it('steps at the next keyframe when the segment holds', () => {
    const param = animatedNumber([kf(0, 0, 'hold'), kf(10, 1, 'linear')]);
    expect(evaluateAt(param, frameIndex(0))).toBe(0);
    expect(evaluateAt(param, frameIndex(9))).toBe(0);
    expect(evaluateAt(param, frameIndex(10))).toBe(1);
  });

  it('walks a multi-segment curve, picking the right segment each time', () => {
    const param = animatedNumber([kf(0, 0), kf(10, 1), kf(20, 0), kf(30, 0.5)]);
    expect(evaluateAt(param, frameIndex(5))).toBeCloseTo(0.5, 10);
    expect(evaluateAt(param, frameIndex(15))).toBeCloseTo(0.5, 10);
    expect(evaluateAt(param, frameIndex(25))).toBeCloseTo(0.25, 10);
  });

  it('finds the correct segment in a long curve, exercising the binary search', () => {
    // One keyframe every 10 frames, value == frame, so the expected result is exact.
    const keyframes = Array.from({ length: 200 }, (_, i) => kf(i * 10, i * 10));
    const param = animatedNumber(keyframes);
    for (const frame of [0, 1, 7, 55, 199, 1000, 1234, 1990]) {
      expect(evaluateAt(param, frameIndex(frame))).toBeCloseTo(frame, 6);
    }
  });

  it('handles a single keyframe as a constant', () => {
    const param = animatedNumber([kf(42, 0.7)]);
    expect(evaluateAt(param, frameIndex(0))).toBe(0.7);
    expect(evaluateAt(param, frameIndex(42))).toBe(0.7);
    expect(evaluateAt(param, frameIndex(99))).toBe(0.7);
  });

  it('treats an empty keyframe list as zero rather than crashing the render loop', () => {
    expect(evaluateAt(animatedNumber([]), frameIndex(0))).toBe(0);
  });

  it('interpolates negative and descending values', () => {
    const param = animatedNumber([kf(0, 10), kf(10, -10)]);
    expect(evaluateAt(param, frameIndex(5))).toBeCloseTo(0, 10);
  });
});

describe('transforms', () => {
  it('shifts keyframes with a head trim so animation stays glued to the picture', () => {
    const param = shiftKeyframes(animatedNumber([kf(10, 0), kf(20, 1)]), -10);
    expect(isAnimated(param) && param.keyframes.map((k) => k.frame)).toEqual([0, 10]);
  });

  it('leaves a static parameter untouched when shifting', () => {
    expect(shiftKeyframes(staticNumber(1), 10)).toEqual(staticNumber(1));
  });

  it('scales keyframe positions proportionally', () => {
    const param = scaleKeyframes(animatedNumber([kf(0, 0), kf(10, 1)]), 2);
    expect(isAnimated(param) && param.keyframes.map((k) => k.frame)).toEqual([0, 20]);
  });

  it('rejects a non-positive scale factor', () => {
    expect(() => scaleKeyframes(animatedNumber([kf(0, 0)]), 0)).toThrow(RangeError);
    expect(() => scaleKeyframes(animatedNumber([kf(0, 0)]), -1)).toThrow(RangeError);
  });

  it('freezes an animated parameter to its value at one frame', () => {
    const frozen = freezeAt(animatedNumber([kf(0, 0), kf(10, 1)]), frameIndex(5));
    expect(frozen).toEqual(staticNumber(0.5));
  });
});

/**
 * The hand-drawn curve.
 *
 * Issue #37 asked for "bezier or my own curve", which is four numbers rather than a sixth preset —
 * a preset list can never contain the curve someone actually wants. The properties worth pinning are
 * the ones a wrong solver breaks silently: the endpoints, monotonic time, and the fact that a curve
 * matching linear's control points evaluates as linear everywhere rather than nearly everywhere.
 */
describe('a bezier easing', () => {
  it('pins both endpoints exactly, whatever the control points are', () => {
    const wild = bezierEase({ x1: 0.9, y1: -1.2, x2: 0.1, y2: 2.4 });
    expect(evaluateBezier(wild, 0)).toBe(0);
    expect(evaluateBezier(wild, 1)).toBe(1);
  });

  it('is linear when its control points are', () => {
    // The curve `bezier` starts from, so switching a marker to it changes nothing until it is dragged.
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(evaluateBezier(DEFAULT_BEZIER, t)).toBeCloseTo(t, 4);
    }
  });

  it('matches the CSS ease-in-out curve, which is the reference every user has', () => {
    // cubic-bezier(0.42, 0, 0.58, 1) is `ease-in-out` in every browser; halfway is exactly half.
    const cssEaseInOut = bezierEase({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
    expect(evaluateBezier(cssEaseInOut, 0.5)).toBeCloseTo(0.5, 5);
    expect(evaluateBezier(cssEaseInOut, 0.25)).toBeLessThan(0.25);
    expect(evaluateBezier(cssEaseInOut, 0.75)).toBeGreaterThan(0.75);
  });

  it('solves a curve whose control points sit on the endpoints, where Newton stalls', () => {
    // cubic-bezier(1, 0, 0, 1) — the hardest ease a user can ask for, and the case that makes the
    // derivative vanish. Without the bisection fallback this returns whatever Newton last guessed.
    const hard = bezierEase({ x1: 1, y1: 0, x2: 0, y2: 1 });
    expect(evaluateBezier(hard, 0.5)).toBeCloseTo(0.5, 4);
    expect(evaluateBezier(hard, 0.2)).toBeLessThan(0.1);
    expect(evaluateBezier(hard, 0.8)).toBeGreaterThan(0.9);
  });

  it('overshoots when asked to, because that is what a spring curve is', () => {
    const overshoot = bezierEase({ x1: 0.3, y1: 0, x2: 0.6, y2: 1.8 });
    const peak = Math.max(...[0.6, 0.7, 0.8, 0.9].map((t) => evaluateBezier(overshoot, t)));
    expect(peak).toBeGreaterThan(1);
  });

  it('clamps the time coordinates, since a curve running backwards has no meaning here', () => {
    expect(bezierEase({ x1: -3, y1: 0, x2: 4, y2: 1 })).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
    expect(bezierEase({ x1: Number.NaN, y1: Number.NaN, x2: 1, y2: 1 })).toEqual({
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
    });
  });

  it('leaves the value coordinates alone, because overshoot is legitimate', () => {
    expect(bezierEase({ x1: 0.2, y1: -0.5, x2: 0.8, y2: 1.5 }).y2).toBe(1.5);
  });

  it('drives a keyframe segment through the curve', () => {
    const param = animatedNumber([
      {
        id: keyframeId('b1'),
        frame: frameIndex(0),
        value: 0,
        ease: 'bezier',
        bezier: bezierEase({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 }),
      },
      { id: keyframeId('b2'), frame: frameIndex(100), value: 10, ease: 'linear' },
    ]);
    expect(evaluateAt(param, frameIndex(50))).toBeCloseTo(5, 4);
    expect(evaluateAt(param, frameIndex(25))).toBeLessThan(2.5);
  });

  it('falls back to linear when a file says bezier and gives no points', () => {
    // Refusing to evaluate would blank a frame over a missing default.
    expect(applyEasing('bezier', 0.3)).toBe(0.3);
  });
});
