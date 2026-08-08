import { describe, expect, it } from 'vitest';
import type { GlyphAdvances } from '../contracts/text-raster.js';
import { buildAdvances, toCumulativeAdvances, typewriterAt, wrapText } from './typewriter.js';

/** Every character 10 px wide, so expected advances are readable by inspection. */
const CHAR_WIDTH = 10;
const measureChar = (): number => CHAR_WIDTH;
const measureLine = (text: string): number => text.length * CHAR_WIDTH;

function advancesFor(lines: readonly string[], align: 'left' | 'center' | 'right' = 'left'): GlyphAdvances {
  return buildAdvances(lines, {
    measureCharacter: measureChar,
    measureLine,
    fontSize: 20,
    lineHeight: 1.2,
    letterSpacing: 0,
    align,
    boxWidth: 200,
  });
}

describe('toCumulativeAdvances', () => {
  it('produces a prefix sum, so the Nth advance is where character N ends', () => {
    expect(toCumulativeAdvances([10, 10, 10])).toEqual([10, 20, 30]);
  });

  it('adds letter spacing after each character', () => {
    expect(toCumulativeAdvances([10, 10], 2)).toEqual([12, 24]);
  });

  it('handles an empty string', () => {
    expect(toCumulativeAdvances([])).toEqual([]);
  });
});

describe('buildAdvances', () => {
  it('records one advance per character', () => {
    const advances = advancesFor(['abc']);
    expect(advances.lines[0]!.advances).toEqual([10, 20, 30]);
  });

  it('counts characters across all lines', () => {
    expect(advancesFor(['ab', 'cde']).totalCharacters).toBe(5);
  });

  it('tracks each line start index into the original string, newlines included', () => {
    // So a caller can map a revealed count back to a position in the source text.
    const advances = advancesFor(['ab', 'cde']);
    expect(advances.lines.map((line) => line.startIndex)).toEqual([0, 3]);
  });

  it('places baselines one line height apart, first one down', () => {
    // The first baseline sits a full line down so ascenders are not clipped at the texture top.
    const advances = advancesFor(['a', 'b']);
    expect(advances.lines.map((line) => line.baselineY)).toEqual([24, 48]);
  });

  it('left-aligns at the origin', () => {
    expect(advancesFor(['abc'], 'left').lines[0]!.originX).toBe(0);
  });

  it('centres a line within the box', () => {
    // 200 px box, 30 px line: 85 px on each side.
    expect(advancesFor(['abc'], 'center').lines[0]!.originX).toBe(85);
  });

  it('right-aligns against the box edge', () => {
    expect(advancesFor(['abc'], 'right').lines[0]!.originX).toBe(170);
  });

  it('handles an empty line without producing a negative width', () => {
    const advances = advancesFor(['', 'ab']);
    expect(advances.lines[0]!.width).toBe(0);
    expect(advances.lines[0]!.advances).toEqual([]);
  });
});

describe('typewriterAt', () => {
  const advances = advancesFor(['abcde']);

  it('reveals nothing at zero', () => {
    const state = typewriterAt(advances, 0);
    expect(state.revealedCharacters).toBe(0);
    expect(state.lines[0]!.visibleWidth).toBe(0);
    expect(state.complete).toBe(false);
  });

  it('reveals everything at one', () => {
    // Flooring alone would leave the final character hidden at exactly 1.
    const state = typewriterAt(advances, 1);
    expect(state.revealedCharacters).toBe(5);
    expect(state.lines[0]!.visibleWidth).toBe(50);
    expect(state.complete).toBe(true);
  });

  it('floors the count, so a character appears only once fully earned', () => {
    // Rounding would make the first character appear at 0.1 rather than 0.2, which reads as the
    // animation starting late and then jumping.
    expect(typewriterAt(advances, 0.19).revealedCharacters).toBe(0);
    expect(typewriterAt(advances, 0.2).revealedCharacters).toBe(1);
    expect(typewriterAt(advances, 0.39).revealedCharacters).toBe(1);
    expect(typewriterAt(advances, 0.4).revealedCharacters).toBe(2);
  });

  it('clips at the advance after the last visible character', () => {
    const state = typewriterAt(advances, 0.6);
    expect(state.revealedCharacters).toBe(3);
    expect(state.lines[0]!.visibleWidth).toBe(30);
  });

  it('advances monotonically as reveal grows', () => {
    let previous = -1;
    for (let reveal = 0; reveal <= 1.0001; reveal += 0.05) {
      const width = typewriterAt(advances, Math.min(reveal, 1)).lines[0]!.visibleWidth;
      expect(width).toBeGreaterThanOrEqual(previous);
      previous = width;
    }
  });

  it('clamps out-of-range and non-finite reveal', () => {
    expect(typewriterAt(advances, -1).revealedCharacters).toBe(0);
    expect(typewriterAt(advances, 5).revealedCharacters).toBe(5);
    expect(typewriterAt(advances, NaN).revealedCharacters).toBe(0);
  });

  it('treats empty text as already complete', () => {
    const state = typewriterAt({ lines: [], totalCharacters: 0 }, 0);
    expect(state.complete).toBe(true);
    expect(state.lines).toEqual([]);
  });
});

describe('multi-line reveal', () => {
  const advances = advancesFor(['abc', 'de']);

  it('reveals lines in reading order, not in parallel', () => {
    // Revealing all lines at once looks like a wipe, not typing.
    const state = typewriterAt(advances, 0.4);
    expect(state.revealedCharacters).toBe(2);
    expect(state.lines[0]!.visibleCharacters).toBe(2);
    expect(state.lines[1]!.visibleCharacters).toBe(0);
  });

  it('completes a line before starting the next', () => {
    const state = typewriterAt(advances, 0.6);
    expect(state.lines[0]!.visibleCharacters).toBe(3);
    expect(state.lines[0]!.visibleWidth).toBe(advances.lines[0]!.width);
    expect(state.lines[1]!.visibleCharacters).toBe(0);
  });

  it('carries the remainder onto the following line', () => {
    const state = typewriterAt(advances, 0.8);
    expect(state.revealedCharacters).toBe(4);
    expect(state.lines[0]!.visibleCharacters).toBe(3);
    expect(state.lines[1]!.visibleCharacters).toBe(1);
    expect(state.lines[1]!.visibleWidth).toBe(10);
  });

  it('returns a reveal entry for every line, so the renderer can iterate uniformly', () => {
    expect(typewriterAt(advances, 0).lines).toHaveLength(2);
    expect(typewriterAt(advances, 1).lines).toHaveLength(2);
  });
});

describe('wrapText', () => {
  const measure = (text: string): number => text.length * 10;

  it('leaves short text on one line', () => {
    expect(wrapText('hello', 200, measure)).toEqual(['hello']);
  });

  it('breaks on explicit newlines', () => {
    expect(wrapText('a\nb', 500, measure)).toEqual(['a', 'b']);
  });

  it('preserves a deliberate blank line', () => {
    expect(wrapText('a\n\nb', 500, measure)).toEqual(['a', '', 'b']);
  });

  it('wraps at word boundaries', () => {
    // 60 px fits six characters; "one two" is seven.
    expect(wrapText('one two', 60, measure)).toEqual(['one', 'two']);
  });

  it('breaks a single word wider than the line, so it cannot overflow the frame', () => {
    // A long URL must not run off the edge of the picture.
    const lines = wrapText('abcdefghij', 30, measure);
    expect(lines.every((line) => measure(line) <= 30)).toBe(true);
    expect(lines.join('')).toBe('abcdefghij');
  });

  it('mixes a long word with normal wrapping', () => {
    const lines = wrapText('hi abcdefghij ok', 40, measure);
    expect(lines.every((line) => measure(line) <= 40)).toBe(true);
    expect(lines.join('').replace(/ /g, '')).toBe('hiabcdefghijok');
  });

  it('does not wrap when no width is given', () => {
    expect(wrapText('a very long line indeed', 0, measure)).toEqual(['a very long line indeed']);
  });

  it('handles an empty string', () => {
    expect(wrapText('', 100, measure)).toEqual(['']);
  });
});

describe('reveal against wrapped text', () => {
  it('reveals through a wrap boundary continuously', () => {
    // The wrap is a layout artefact; the user typed one continuous string and expects one continuous
    // reveal across it.
    const lines = wrapText('one two', 60, (text) => text.length * 10);
    const advances = advancesFor(lines);
    expect(advances.totalCharacters).toBe(6);

    const counts = [0, 0.2, 0.5, 0.9, 1].map(
      (reveal) => typewriterAt(advances, reveal).revealedCharacters,
    );
    expect(counts).toEqual([0, 1, 3, 5, 6]);
  });
});
