import { describe, expect, it } from 'vitest';
import { frameCount, frameIndex } from './frame-time.js';
import {
  EMPTY_SPAN,
  type FrameSpan,
  compareSpans,
  containsFrame,
  containsSpan,
  endExclusive,
  frameSpan,
  intersection,
  isAdjacent,
  isEmpty,
  lastFrame,
  overlaps,
  spanFromBounds,
  spansEqual,
  split,
  subtractSpan,
  translate,
  trimEnd,
  trimStart,
  union,
} from './frame-span.js';

/** `[start, end)` shorthand so the tests read like the intervals they describe. */
function span(start: number, end: number): FrameSpan {
  return spanFromBounds(frameIndex(start), frameIndex(end));
}

describe('construction', () => {
  it('derives duration from bounds', () => {
    expect(span(10, 20)).toEqual({ start: 10, duration: 10 });
  });

  it('allows an empty span at a position', () => {
    expect(isEmpty(span(10, 10))).toBe(true);
  });

  it('rejects an inverted range', () => {
    expect(() => span(20, 10)).toThrow(RangeError);
  });

  it('exposes the exclusive end and the last contained frame', () => {
    expect(endExclusive(span(10, 20))).toBe(20);
    expect(lastFrame(span(10, 20))).toBe(19);
  });

  it('has no last frame when empty', () => {
    expect(() => lastFrame(EMPTY_SPAN)).toThrow(RangeError);
  });
});

describe('containment', () => {
  it('includes the start and excludes the end', () => {
    const s = span(10, 20);
    expect(containsFrame(s, frameIndex(10))).toBe(true);
    expect(containsFrame(s, frameIndex(19))).toBe(true);
    expect(containsFrame(s, frameIndex(20))).toBe(false);
    expect(containsFrame(s, frameIndex(9))).toBe(false);
  });

  it('contains a nested span, including its own bounds', () => {
    expect(containsSpan(span(10, 20), span(12, 18))).toBe(true);
    expect(containsSpan(span(10, 20), span(10, 20))).toBe(true);
    expect(containsSpan(span(10, 20), span(10, 21))).toBe(false);
    expect(containsSpan(span(10, 20), span(9, 20))).toBe(false);
  });
});

describe('overlap and adjacency', () => {
  it('detects a shared frame', () => {
    expect(overlaps(span(10, 20), span(19, 30))).toBe(true);
    expect(overlaps(span(10, 20), span(20, 30))).toBe(false);
    expect(overlaps(span(20, 30), span(10, 20))).toBe(false);
  });

  it('is symmetric', () => {
    expect(overlaps(span(10, 20), span(15, 25))).toBe(overlaps(span(15, 25), span(10, 20)));
  });

  it('never overlaps an empty span, so a zero-length insert is always legal', () => {
    expect(overlaps(span(10, 20), span(15, 15))).toBe(false);
    expect(overlaps(EMPTY_SPAN, EMPTY_SPAN)).toBe(false);
  });

  it('treats touching spans as adjacent in either order', () => {
    expect(isAdjacent(span(10, 20), span(20, 30))).toBe(true);
    expect(isAdjacent(span(20, 30), span(10, 20))).toBe(true);
    expect(isAdjacent(span(10, 20), span(21, 30))).toBe(false);
  });
});

describe('set operations', () => {
  it('intersects overlapping spans', () => {
    expect(intersection(span(10, 20), span(15, 25))).toEqual(span(15, 20));
  });

  it('returns undefined for disjoint spans', () => {
    expect(intersection(span(10, 20), span(20, 30))).toBeUndefined();
  });

  it('unions across a gap', () => {
    expect(union(span(10, 15), span(20, 30))).toEqual(span(10, 30));
  });

  it('treats an empty span as the union identity', () => {
    expect(union(EMPTY_SPAN, span(10, 20))).toEqual(span(10, 20));
    expect(union(span(10, 20), EMPTY_SPAN)).toEqual(span(10, 20));
  });

  it('subtracts a disjoint cut as a no-op', () => {
    expect(subtractSpan(span(10, 20), span(30, 40))).toEqual([span(10, 20)]);
  });

  it('subtracts a leading cut', () => {
    expect(subtractSpan(span(10, 20), span(5, 15))).toEqual([span(15, 20)]);
  });

  it('subtracts a trailing cut', () => {
    expect(subtractSpan(span(10, 20), span(15, 25))).toEqual([span(10, 15)]);
  });

  it('punches a hole, yielding two pieces in timeline order', () => {
    expect(subtractSpan(span(10, 30), span(15, 20))).toEqual([span(10, 15), span(20, 30)]);
  });

  it('yields nothing when the cut swallows the span', () => {
    expect(subtractSpan(span(10, 20), span(5, 25))).toEqual([]);
  });
});

describe('editing operations', () => {
  it('translates without changing duration', () => {
    expect(translate(span(10, 20), 5)).toEqual(span(15, 25));
    expect(translate(span(10, 20), -10)).toEqual(span(0, 10));
  });

  it('trims the head, keeping the end fixed', () => {
    expect(trimStart(span(10, 20), 3)).toEqual(span(13, 20));
    expect(trimStart(span(10, 20), -5)).toEqual(span(5, 20));
  });

  it('collapses to empty rather than inverting on head overshoot', () => {
    expect(trimStart(span(10, 20), 50)).toEqual(span(20, 20));
  });

  it('trims the tail, keeping the start fixed', () => {
    expect(trimEnd(span(10, 20), -3)).toEqual(span(10, 17));
    expect(trimEnd(span(10, 20), 5)).toEqual(span(10, 25));
  });

  it('collapses to empty rather than inverting on tail overshoot', () => {
    expect(trimEnd(span(10, 20), -50)).toEqual(span(10, 10));
  });

  it('splits into two adjacent halves that reconstruct the original', () => {
    const result = split(span(10, 20), frameIndex(14));
    expect(result).toEqual([span(10, 14), span(14, 20)]);
    const [left, right] = result!;
    expect(isAdjacent(left, right)).toBe(true);
    expect(union(left, right)).toEqual(span(10, 20));
  });

  it('refuses to split on a boundary, so no zero-length clip is produced', () => {
    expect(split(span(10, 20), frameIndex(10))).toBeUndefined();
    expect(split(span(10, 20), frameIndex(20))).toBeUndefined();
    expect(split(span(10, 20), frameIndex(25))).toBeUndefined();
  });
});

describe('ordering', () => {
  it('sorts by start, then duration', () => {
    const spans = [span(20, 30), span(10, 30), span(10, 15)];
    expect([...spans].sort(compareSpans)).toEqual([span(10, 15), span(10, 30), span(20, 30)]);
  });

  it('compares equality structurally', () => {
    expect(spansEqual(span(10, 20), frameSpan(frameIndex(10), frameCount(10)))).toBe(true);
    expect(spansEqual(span(10, 20), span(10, 21))).toBe(false);
  });
});
