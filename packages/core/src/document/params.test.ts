import { describe, expect, it } from 'vitest';
import { frameIndex } from '../time/frame-time.js';
import { keyframeId } from './ids.js';
import {
  type Easing,
  type Keyframe,
  animatedNumber,
  applyEasing,
  evaluateAt,
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

  it('recognizes exactly the five documented easings', () => {
    for (const ease of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']) {
      expect(isEasing(ease)).toBe(true);
    }
    expect(isEasing('bezier')).toBe(false);
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
