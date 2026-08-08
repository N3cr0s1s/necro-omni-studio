import { describe, expect, it } from 'vitest';
import { frameIndex } from '@nos/core';
import type { MaskFrame } from '../contracts/mask.js';
import {
  countsFromString,
  countsToString,
  decodeRle,
  encodeRle,
  isWellFormed,
  maskArea,
  toAlpha,
  toRgba,
} from './rle.js';

/** A bitmap from an ASCII picture, so a test reads as the shape it asserts. */
function bitmapOf(rows: readonly string[]): { bitmap: Uint8Array; width: number; height: number } {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const bitmap = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      bitmap[y * width + x] = cell === '#' ? 1 : 0;
    });
  });
  return { bitmap, width, height };
}

const pictureOf = (bitmap: Uint8Array, width: number, height: number): readonly string[] =>
  Array.from({ length: height }, (_unused, y) =>
    Array.from({ length: width }, (_cell, x) => (bitmap[y * width + x] === 1 ? '#' : '.')).join(''),
  );

describe('round tripping', () => {
  it('recovers the picture exactly', () => {
    const rows = ['..##..', '.####.', '.####.', '..##..'];
    const { bitmap, width, height } = bitmapOf(rows);
    const counts = encodeRle(bitmap, width, height);
    expect(pictureOf(decodeRle(counts, width, height), width, height)).toEqual(rows);
  });

  it('handles an empty mask', () => {
    const { bitmap, width, height } = bitmapOf(['....', '....']);
    const counts = encodeRle(bitmap, width, height);
    expect(maskArea(counts)).toBe(0);
    expect(decodeRle(counts, width, height).every((value) => value === 0)).toBe(true);
  });

  it('handles a full mask', () => {
    const { bitmap, width, height } = bitmapOf(['####', '####']);
    const counts = encodeRle(bitmap, width, height);
    // Starts with an empty zero run, which is what keeps the parity meaningful.
    expect(counts[0]).toBe(0);
    expect(maskArea(counts)).toBe(8);
  });

  it('handles a single pixel in every corner', () => {
    for (const rows of [
      ['#...', '....'],
      ['...#', '....'],
      ['....', '#...'],
      ['....', '...#'],
    ]) {
      const { bitmap, width, height } = bitmapOf(rows);
      const counts = encodeRle(bitmap, width, height);
      expect(pictureOf(decodeRle(counts, width, height), width, height), rows.join('/')).toEqual(rows);
    }
  });

  it('round trips a non-square frame, where a row/column mix-up would show', () => {
    // The classic failure: encoding column-major and decoding row-major agrees on a square and transposes
    // everything else.
    const rows = ['#..', '.#.', '..#', '#.#'];
    const { bitmap, width, height } = bitmapOf(rows);
    expect(pictureOf(decodeRle(encodeRle(bitmap, width, height), width, height), width, height)).toEqual(
      rows,
    );
  });
});

describe('the wire format', () => {
  it('is column-major, as COCO defines it', () => {
    // Matching COCO is the whole reason for the format: masks from any SAM-family tool decode here
    // unchanged. A row-major variant would look identical in every square test and be wrong everywhere.
    const { bitmap, width, height } = bitmapOf(['#.', '#.']);
    // Column 0 is two ones, column 1 is two zeros → [0, 2, 2].
    expect(encodeRle(bitmap, width, height)).toEqual([0, 2, 2]);
  });

  it('always begins with a zero run', () => {
    const { bitmap, width, height } = bitmapOf(['##', '##']);
    expect(encodeRle(bitmap, width, height)[0]).toBe(0);
  });

  it('sums to the frame area', () => {
    const { bitmap, width, height } = bitmapOf(['#.#.', '.##.', '....']);
    const counts = encodeRle(bitmap, width, height);
    expect(counts.reduce((sum, run) => sum + run, 0)).toBe(width * height);
  });

  it('counts area without decoding', () => {
    const { bitmap, width, height } = bitmapOf(['#.#.', '.##.']);
    expect(maskArea(encodeRle(bitmap, width, height))).toBe(4);
  });

  it('rejects a bitmap that does not match its dimensions', () => {
    expect(() => encodeRle(new Uint8Array(5), 2, 2)).toThrow(RangeError);
  });

  it('treats any non-zero as inside, since engines emit 255', () => {
    const bitmap = new Uint8Array([255, 0, 1, 0]);
    expect(maskArea(encodeRle(bitmap, 2, 2))).toBe(2);
  });
});

describe('decoding hostile input', () => {
  it('rejects a negative or fractional run', () => {
    expect(() => decodeRle([0, -1], 2, 2)).toThrow(RangeError);
    expect(() => decodeRle([0, 1.5], 2, 2)).toThrow(RangeError);
  });

  it('does not write past the frame when the counts overrun', () => {
    // A truncated or foreign file must not corrupt memory or throw deep inside a loop.
    const bitmap = decodeRle([0, 1000], 2, 2);
    expect(bitmap).toHaveLength(4);
    expect([...bitmap]).toEqual([1, 1, 1, 1]);
  });

  it('leaves the rest zero when the counts fall short', () => {
    expect([...decodeRle([0, 1], 2, 2)]).toEqual([1, 0, 0, 0]);
  });

  it('decodes an empty count list as an empty mask', () => {
    expect([...decodeRle([], 2, 2)]).toEqual([0, 0, 0, 0]);
  });
});

describe('texture forms', () => {
  it('emits 255 rather than 1, so the mask is visible as a colour channel', () => {
    // A value of 1/255 reads as black: a mask technically present and visually absent.
    const { bitmap, width, height } = bitmapOf(['#.', '..']);
    const alpha = toAlpha(encodeRle(bitmap, width, height), width, height);
    expect(alpha[0]).toBe(255);
    expect(alpha[1]).toBe(0);
  });

  it('fills every RGBA channel', () => {
    // An effect may sample the mask as `.r` or rely on `.a`; a mask that worked in one shader and silently
    // failed in the other would be miserable to debug.
    const { bitmap, width, height } = bitmapOf(['#.']);
    const rgba = toRgba(encodeRle(bitmap, width, height), width, height);
    expect([...rgba.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...rgba.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  });

  it('produces four bytes per pixel', () => {
    const { bitmap, width, height } = bitmapOf(['##', '##']);
    expect(toRgba(encodeRle(bitmap, width, height), width, height)).toHaveLength(16);
  });
});

describe('the text form', () => {
  it('round trips', () => {
    const counts = [0, 3, 2, 7];
    expect(countsFromString(countsToString(counts))).toEqual(counts);
  });

  it('reads an empty list', () => {
    expect(countsFromString('')).toEqual([]);
  });

  it('rejects anything that is not a run length', () => {
    // A corrupt file must be a cache miss, not a mask with a tear in it.
    for (const text of ['1,x,2', '1,-2', '1,2.5']) {
      expect(() => countsFromString(text)).toThrow(RangeError);
    }
  });
});

describe('well-formedness', () => {
  const frame = (counts: readonly number[]): MaskFrame => ({
    frame: frameIndex(0),
    width: 2,
    height: 2,
    counts,
  });

  it('accepts counts covering the frame', () => {
    expect(isWellFormed(frame([0, 2, 2]))).toBe(true);
  });

  it('rejects counts that do not', () => {
    expect(isWellFormed(frame([0, 2]))).toBe(false);
    expect(isWellFormed(frame([0, 2, 2, 1]))).toBe(false);
  });
});
