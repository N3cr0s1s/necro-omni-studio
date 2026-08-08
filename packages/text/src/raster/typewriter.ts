import type { GlyphAdvances, LineAdvances } from '../contracts/text-raster.js';
import { type TypewriterCut, clamp01 } from '@nos/core';

/**
 * The typewriter reveal.
 *
 * The spec singles this out as its own mechanism rather than a transform keyframe, because the number of
 * *visible characters* changes over time and no transform expresses that. Its three steps are:
 *
 * 1. Rasterize the whole text once into a texture.
 * 2. Store the cumulative x advance after each character.
 * 3. Per frame, compute how many characters are visible and clip the quad at that advance.
 *
 * Everything here is step 3, and it is pure arithmetic over the advance list — no canvas, no GL. That is
 * what makes "the same characters are visible in preview and export" testable rather than hoped for.
 */

/** How much of one line to draw. */
export interface LineReveal {
  readonly line: LineAdvances;
  /**
   * Width to draw from the line's origin, in texture pixels.
   *
   * Zero means the line has not started; the full line width means it is complete.
   */
  readonly visibleWidth: number;
  /** Characters revealed on this line, for callers that want a caret or a per-character effect. */
  readonly visibleCharacters: number;
}

export interface TypewriterState {
  /** Characters revealed across the whole text. */
  readonly revealedCharacters: number;
  readonly lines: readonly LineReveal[];
  /** True when everything is visible, so the renderer can skip clipping entirely. */
  readonly complete: boolean;
}

/**
 * Computes what is visible at a reveal fraction.
 *
 * Characters are revealed in reading order across lines: a line only begins once the previous is
 * complete. Revealing all lines in parallel would look like a fade-in wipe, not typing.
 *
 * The count is **floored**, so a character appears only once it is fully earned. Rounding would make the
 * first character appear at reveal 0.5/n, which reads as the animation starting late and then jumping.
 */
export function typewriterAt(advances: GlyphAdvances, reveal: number): TypewriterState {
  const clamped = clamp01(reveal);
  const total = advances.totalCharacters;

  if (total === 0) {
    return { revealedCharacters: 0, lines: [], complete: true };
  }

  // At exactly 1 every character is visible; flooring alone would leave the last one hidden.
  const revealed = clamped >= 1 ? total : Math.floor(clamped * total);

  const lines: LineReveal[] = [];
  let remaining = revealed;

  for (const line of advances.lines) {
    const lineLength = line.text.length;

    if (remaining <= 0) {
      lines.push({ line, visibleWidth: 0, visibleCharacters: 0 });
      continue;
    }

    if (remaining >= lineLength) {
      lines.push({ line, visibleWidth: line.width, visibleCharacters: lineLength });
      remaining -= lineLength;
      continue;
    }

    // Partially revealed: clip at the advance after the last visible character.
    const visibleWidth = remaining === 0 ? 0 : (line.advances[remaining - 1] ?? 0);
    lines.push({ line, visibleWidth, visibleCharacters: remaining });
    remaining = 0;
  }

  return { revealedCharacters: revealed, lines, complete: revealed >= total };
}

/**
 * Where the raster was placed on the frame, so advances measured in raster pixels can be located.
 *
 * The compositor draws every layer as a fullscreen quad, so a title is composed onto a frame-sized
 * surface before upload. The advances are still in the *measured* raster's coordinates, and this is
 * the offset that reconciles the two.
 */
export interface RasterPlacement {
  readonly x: number;
  readonly y: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
}

/**
 * The cut for a reveal fraction, or nothing when the whole text is visible.
 *
 * `undefined` for a complete reveal is what keeps this free for the overwhelmingly common case: a
 * title with no typewriter animation is complete at every frame, and the renderer skips the cut
 * entirely rather than paying for a no-op clip on every layer of every frame.
 */
export function typewriterCut(
  advances: GlyphAdvances,
  reveal: number,
  placement: RasterPlacement,
): TypewriterCut | undefined {
  const state = typewriterAt(advances, reveal);
  if (state.complete) return undefined;

  /*
   * `buildAdvances` puts the first baseline exactly one line height down, so the first line's baseline
   * *is* the line spacing. Deriving it rather than carrying it keeps the advance table to what a
   * rasterizer can actually measure.
   */
  const spacing = advances.lines[0]?.baselineY ?? placement.frameHeight;

  const index = state.lines.findIndex((line) => line.visibleCharacters < line.line.text.length);
  const partial = state.lines[index];
  if (partial === undefined) return undefined;

  const top = placement.y + spacing * index;
  /*
   * The band runs a third of a line past the baseline so descenders survive. A `g` on the line being
   * typed hangs below its own baseline, and a band that stopped there would shave the tails off while
   * the line was mid-word and restore them when the next line started — a flicker that reads as a
   * font problem rather than as a clipping rule.
   */
  const bottom = placement.y + spacing * (index + 1) + spacing * 0.3;

  return {
    doneV: 1 - top / placement.frameHeight,
    lineV: [1 - bottom / placement.frameHeight, 1 - top / placement.frameHeight],
    lineU: (placement.x + partial.line.originX + partial.visibleWidth) / placement.frameWidth,
  };
}

/**
 * Builds cumulative advances from per-character widths.
 *
 * Exposed so a rasterizer only has to measure each glyph; the prefix sum belongs here, next to the code
 * that consumes it, rather than being reimplemented by every rasterizer.
 */
export function toCumulativeAdvances(widths: readonly number[], letterSpacing = 0): readonly number[] {
  const advances: number[] = [];
  let total = 0;
  for (const width of widths) {
    total += width + letterSpacing;
    advances.push(total);
  }
  return advances;
}

/**
 * Splits text into lines, wrapping at a maximum width.
 *
 * Word wrapping with a character-level fallback: a single word longer than the line must still break, or
 * a long URL would overflow the frame. Explicit newlines always break.
 *
 * `measure` is injected so this is testable without a canvas and identical between rasterizers.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): readonly string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      // An empty paragraph is a deliberate blank line, not something to collapse.
      lines.push('');
      continue;
    }
    if (maxWidth <= 0 || measure(paragraph) <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    lines.push(...wrapParagraph(paragraph, maxWidth, measure));
  }

  return lines;
}

function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  measure: (text: string) => number,
): readonly string[] {
  const lines: string[] = [];
  const words = paragraph.split(' ');
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current !== '') {
      lines.push(current);
      current = '';
    }

    if (measure(word) <= maxWidth) {
      current = word;
      continue;
    }

    // A single word wider than the line: break it by characters so it cannot overflow the frame.
    let chunk = '';
    for (const character of word) {
      if (chunk !== '' && measure(chunk + character) > maxWidth) {
        lines.push(chunk);
        chunk = character;
      } else {
        chunk += character;
      }
    }
    current = chunk;
  }

  if (current !== '') lines.push(current);
  return lines;
}

/**
 * Builds the advance table for a set of laid-out lines.
 *
 * `lineHeight` is a multiplier of the font size, matching the document model, and the first baseline sits
 * one line height down so ascenders are not clipped at the top of the texture.
 */
export function buildAdvances(
  lines: readonly string[],
  options: {
    readonly measureCharacter: (character: string, lineText: string, index: number) => number;
    readonly measureLine: (text: string) => number;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly letterSpacing: number;
    readonly align: 'left' | 'center' | 'right';
    readonly boxWidth: number;
  },
): GlyphAdvances {
  const lineSpacing = options.fontSize * options.lineHeight;
  const result: LineAdvances[] = [];
  let startIndex = 0;

  lines.forEach((text, index) => {
    const widths = [...text].map((character, characterIndex) =>
      options.measureCharacter(character, text, characterIndex),
    );
    const advances = toCumulativeAdvances(widths, options.letterSpacing);
    const width = options.measureLine(text);

    result.push({
      startIndex,
      text,
      advances,
      baselineY: lineSpacing * (index + 1),
      originX: alignOrigin(width, options.boxWidth, options.align),
      width,
    });

    // The +1 accounts for the newline that separated this line from the next, so a character index into
    // the original string stays meaningful.
    startIndex += text.length + 1;
  });

  return {
    lines: result,
    totalCharacters: result.reduce((total, line) => total + line.text.length, 0),
  };
}

function alignOrigin(lineWidth: number, boxWidth: number, align: 'left' | 'center' | 'right'): number {
  switch (align) {
    case 'center':
      return (boxWidth - lineWidth) / 2;
    case 'right':
      return boxWidth - lineWidth;
    default:
      return 0;
  }
}
