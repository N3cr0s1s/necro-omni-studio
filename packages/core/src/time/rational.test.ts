import { describe, expect, it } from 'vitest';
import {
  RationalError,
  add,
  ceil,
  compare,
  divide,
  equals,
  floor,
  formatRational,
  fromNumber,
  gcd,
  lcm,
  multiply,
  negate,
  parseRational,
  rational,
  reciprocal,
  round,
  subtract,
  toNumber,
} from './rational.js';

describe('rational', () => {
  it('normalizes by the greatest common divisor', () => {
    expect(rational(6, 8)).toEqual({ numerator: 3, denominator: 4 });
    expect(rational(30000, 1001)).toEqual({ numerator: 30000, denominator: 1001 });
  });

  it('carries sign on the numerator', () => {
    expect(rational(1, -2)).toEqual({ numerator: -1, denominator: 2 });
    expect(rational(-1, -2)).toEqual({ numerator: 1, denominator: 2 });
  });

  it('rejects non-integer parts, because a float here means a leak', () => {
    expect(() => rational(1.5, 2)).toThrow(RationalError);
    expect(() => rational(1, 0)).toThrow(RationalError);
  });

  it('treats zero consistently', () => {
    expect(rational(0, 5)).toEqual({ numerator: 0, denominator: 1 });
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly across denominators', () => {
    expect(add(rational(1, 3), rational(1, 6))).toEqual({ numerator: 1, denominator: 2 });
    expect(subtract(rational(1, 3), rational(1, 3))).toEqual({ numerator: 0, denominator: 1 });
  });

  it('multiplies and divides exactly', () => {
    expect(multiply(rational(2, 3), rational(3, 4))).toEqual({ numerator: 1, denominator: 2 });
    expect(divide(rational(1, 2), rational(1, 4))).toEqual({ numerator: 2, denominator: 1 });
  });

  it('refuses to divide by zero', () => {
    expect(() => divide(rational(1), rational(0))).toThrow(RationalError);
    expect(() => reciprocal(rational(0))).toThrow(RationalError);
  });

  it('sums a third three times back to exactly one', () => {
    const third = rational(1, 3);
    expect(equals(add(add(third, third), third), rational(1))).toBe(true);
  });

  it('accumulates 29.97 frame durations without drift', () => {
    // The float version of this loop is off by ~1e-12 after 10000 frames, which is
    // what eventually becomes a one-frame slip on a long timeline.
    const frameDuration = rational(1001, 30000);
    let total = rational(0);
    for (let i = 0; i < 10_000; i += 1) total = add(total, frameDuration);
    expect(equals(total, rational(10_010, 30))).toBe(true);
    expect(equals(multiply(total, rational(30000, 1001)), rational(10_000))).toBe(true);
  });

  it('negates and compares', () => {
    expect(negate(rational(3, 4))).toEqual({ numerator: -3, denominator: 4 });
    expect(compare(rational(1, 3), rational(1, 2))).toBeLessThan(0);
    expect(compare(rational(1, 2), rational(1, 2))).toBe(0);
    expect(compare(rational(2, 3), rational(1, 2))).toBeGreaterThan(0);
  });
});

describe('rounding', () => {
  it('floors and ceils toward the expected side for negatives', () => {
    expect(floor(rational(-1, 2))).toBe(-1);
    expect(ceil(rational(-1, 2))).toBe(0);
    expect(floor(rational(7, 2))).toBe(3);
    expect(ceil(rational(7, 2))).toBe(4);
  });

  it('rounds halves away from zero, symmetrically', () => {
    expect(round(rational(1, 2))).toBe(1);
    expect(round(rational(-1, 2))).toBe(-1);
    expect(round(rational(3, 2))).toBe(2);
    expect(round(rational(-3, 2))).toBe(-2);
  });
});

describe('parsing and formatting', () => {
  it('parses fractions and integers', () => {
    expect(parseRational('30000/1001')).toEqual({ numerator: 30000, denominator: 1001 });
    expect(parseRational(' 25 ')).toEqual({ numerator: 25, denominator: 1 });
  });

  it('snaps broadcast decimals to their exact rational form', () => {
    expect(parseRational('29.97')).toEqual({ numerator: 30000, denominator: 1001 });
    expect(parseRational('23.976')).toEqual({ numerator: 24000, denominator: 1001 });
    expect(parseRational('59.94')).toEqual({ numerator: 60000, denominator: 1001 });
  });

  it('expands other decimals exactly', () => {
    expect(fromNumber(23.5)).toEqual({ numerator: 47, denominator: 2 });
  });

  it('round-trips through formatting', () => {
    for (const text of ['24', '30000/1001', '1/2']) {
      expect(formatRational(parseRational(text))).toBe(text);
    }
  });

  it('rejects garbage', () => {
    expect(() => parseRational('banana')).toThrow(RationalError);
  });

  it('converts to a float only at the edge', () => {
    expect(toNumber(rational(30000, 1001))).toBeCloseTo(29.97, 4);
  });
});

describe('gcd and lcm', () => {
  it('computes gcd, treating zero as identity', () => {
    expect(gcd(12, 18)).toBe(6);
    expect(gcd(0, 0)).toBe(1);
    expect(gcd(-12, 18)).toBe(6);
  });

  it('computes lcm', () => {
    expect(lcm(4, 6)).toBe(12);
    expect(lcm(0, 5)).toBe(0);
  });
});
