import { describe, expect, it } from 'vitest';
import { clamp, clamp01 } from './numbers.js';

/**
 * Clamping, in one place.
 *
 * Written down because four copies of `clamp01` had already drifted: three refused a non-finite value
 * and the fourth passed it through, so the same call returned `0` in the compositor and `NaN` in the
 * segmentation panel.
 */

describe('clamp01', () => {
  it('passes a value that is already in range', () => {
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });

  it('pins what is outside it', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(9)).toBe(1);
  });

  it('is zero for what is not a number at all', () => {
    // The half that had drifted. A shader uniform at `NaN` silently blanks the frame it is drawing,
    // and a mask prompt at `NaN` is a point no propagation can start from.
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('clamp', () => {
  it('pins to the bounds given', () => {
    expect(clamp(5, 0, 4)).toBe(4);
    expect(clamp(-5, -1, 1)).toBe(-1);
    expect(clamp(0.5, 0, 4)).toBe(0.5);
  });

  it('falls to the floor for what is not a number', () => {
    // The floor rather than zero: a range that does not contain zero would otherwise be left holding
    // a value outside itself.
    expect(clamp(Number.NaN, -1, 1)).toBe(-1);
    expect(clamp(Number.NaN, 2, 8)).toBe(2);
  });
});
