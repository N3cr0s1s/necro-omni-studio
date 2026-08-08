import { describe, expect, it } from 'vitest';
import { UNKNOWN_CLOCK, clampSeek, formatClock, scrubbableDuration } from './media-clock.js';

describe('a clock reading', () => {
  it('is minutes and seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7)).toBe('0:07');
    expect(formatClock(222)).toBe('3:42');
  });

  it('grows an hours field only when there are hours', () => {
    // `0:03:42` in front of every sound effect in the browser is two characters of nothing, in a
    // column that is already narrow.
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(3599)).toBe('59:59');
  });

  it('floors rather than rounds', () => {
    // A file at 3.6s must not read `0:04` while its own last frame is still on screen, and the same
    // rule keeps `0:07 / 0:07` agreeing at the end of playback.
    expect(formatClock(3.6)).toBe('0:03');
    expect(formatClock(59.99)).toBe('0:59');
  });

  it('says nothing rather than a wrong number', () => {
    // All three arrive from a real media element: `NaN` before metadata, `Infinity` for a stream, and
    // a negative from a seek that raced a load.
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatClock(value), String(value)).toBe(UNKNOWN_CLOCK);
    }
  });
});

describe('a duration worth scrubbing', () => {
  it('is any real length', () => {
    expect(scrubbableDuration(12.5)).toBe(12.5);
  });

  it('is nothing for a length no slider can represent', () => {
    // A slider handed `NaN` as its maximum collapses to its minimum: a scrubber pinned to the left
    // that does nothing when dragged.
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -3]) {
      expect(scrubbableDuration(value), String(value)).toBeUndefined();
    }
  });
});

describe('a seek position', () => {
  it('stays inside the file', () => {
    expect(clampSeek(30, 12)).toBe(12);
    expect(clampSeek(-5, 12)).toBe(0);
    expect(clampSeek(6, 12)).toBe(6);
  });

  it('is left alone when there is no known end', () => {
    // A stream can be seeked past anything this side knows about; refusing would be worse than trying.
    expect(clampSeek(60, undefined)).toBe(60);
  });

  it('is the start for a position that is not a number', () => {
    expect(clampSeek(Number.NaN, 12)).toBe(0);
  });
});
