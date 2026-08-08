/**
 * Verifies the Canvas 2D rasterizer against a real text engine.
 *
 * Glyph measurement cannot be meaningfully faked: the properties that matter — that advances are
 * monotonic, that they agree with what is actually drawn, that wrapping respects the box — only hold
 * against a real font stack. The pure layout code is unit-tested; this checks the half that is not.
 */
import type { TextContent } from '@nos/core';
import { createCanvasRasterizer, createTextRasterCache, typewriterAt } from '../src/index.js';

const rasterizer = createCanvasRasterizer({
  createCanvas: (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  pixelRatio: 2,
});

function content(overrides: Partial<TextContent> = {}): TextContent {
  return {
    text: 'A rendszer',
    font: 'sans-serif',
    size: 48,
    weight: 700,
    color: { r: 1, g: 1, b: 1, a: 1 },
    align: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    ...overrides,
  };
}

/** Counts non-transparent pixels, to prove something was actually drawn. */
function inkCoverage(raster: { image: HTMLCanvasElement | OffscreenCanvas; width: number; height: number }): number {
  const canvas = raster.image as HTMLCanvasElement;
  const context = canvas.getContext('2d')!;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 8) lit += 1;
  return lit / (canvas.width * canvas.height);
}

const results: Record<string, unknown> = {};

// 1. A simple line rasterizes, has ink, and produces one advance per character.
{
  const raster = await rasterizer.rasterize(content(), 1920);
  const line = raster.advances.lines[0]!;
  results.basic = {
    lines: raster.advances.lines.length,
    totalCharacters: raster.advances.totalCharacters,
    advanceCount: line.advances.length,
    textLength: line.text.length,
    monotonic: line.advances.every((value, i) => i === 0 || value > line.advances[i - 1]!),
    lastAdvanceMatchesWidth: Math.abs((line.advances.at(-1) ?? 0) - line.width) < 1.5,
    hasInk: inkCoverage(raster) > 0.005,
    size: [raster.width, raster.height],
  };
}

// 2. Wrapping respects the box, and every produced line fits.
{
  const long = 'The quick brown fox jumps over the lazy dog and keeps running well past the edge';
  const raster = await rasterizer.rasterize(content({ text: long }), 400);
  results.wrapping = {
    lines: raster.advances.lines.length,
    everyLineFits: raster.advances.lines.every((line) => line.width <= 400 * 2 + 1),
    charactersPreserved:
      raster.advances.lines.map((line) => line.text).join(' ').replace(/\s+/g, ' ') ===
      long.replace(/\s+/g, ' '),
  };
}

// 3. Letter spacing widens the line, and advances follow.
{
  const plain = await rasterizer.rasterize(content(), 1920);
  const spaced = await rasterizer.rasterize(content({ letterSpacing: 4 }), 1920);
  results.letterSpacing = {
    widerWithSpacing: spaced.advances.lines[0]!.width > plain.advances.lines[0]!.width,
    advancesGrew:
      (spaced.advances.lines[0]!.advances.at(-1) ?? 0) >
      (plain.advances.lines[0]!.advances.at(-1) ?? 0),
  };
}

// 4. Alignment moves the line origin without changing its width.
{
  const left = await rasterizer.rasterize(content({ align: 'left' }), 1920);
  const centre = await rasterizer.rasterize(content({ align: 'center', text: 'ab\nlonger line' }), 1920);
  results.alignment = {
    leftOriginIsZero: left.advances.lines[0]!.originX === 0,
    // A centred short line must be inset relative to the longer one.
    shortLineInset: centre.advances.lines[0]!.originX > centre.advances.lines[1]!.originX,
  };
}

// 5. Multi-line layout puts baselines a line height apart.
{
  const raster = await rasterizer.rasterize(content({ text: 'one\ntwo\nthree', size: 40, lineHeight: 1.5 }), 1920);
  const baselines = raster.advances.lines.map((line) => line.baselineY);
  const gaps = baselines.slice(1).map((value, i) => value - baselines[i]!);
  results.multiline = {
    lines: baselines.length,
    // 40px at 2x pixel ratio with 1.5 line height = 120.
    gapsEqual: gaps.every((gap) => Math.abs(gap - 120) < 0.01),
  };
}

// 6. An outline and a shadow both add ink without breaking layout.
{
  const plain = await rasterizer.rasterize(content(), 1920);
  const decorated = await rasterizer.rasterize(
    content({
      outline: { width: 3, color: { r: 0, g: 0, b: 0, a: 1 } },
      shadow: { offsetX: 0, offsetY: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.6 } },
    }),
    1920,
  );
  results.decoration = {
    moreInk: inkCoverage(decorated) > inkCoverage(plain),
    // The texture grows to make room for the outline rather than clipping it.
    grew: decorated.width > plain.width,
  };
}

// 7. The typewriter clip lands on real glyph boundaries.
{
  const raster = await rasterizer.rasterize(content({ text: 'abcdef' }), 1920);
  const line = raster.advances.lines[0]!;
  const halfway = typewriterAt(raster.advances, 0.5);
  results.typewriter = {
    revealed: halfway.revealedCharacters,
    // Three of six characters: the clip width must equal the third advance exactly.
    widthMatchesAdvance: Math.abs(halfway.lines[0]!.visibleWidth - line.advances[2]!) < 0.001,
    fullAtOne: typewriterAt(raster.advances, 1).lines[0]!.visibleWidth === line.width,
  };
}

// 8. The cache returns the same object for identical content and sweeps unused entries.
{
  const cache = createTextRasterCache();
  const a = await rasterizer.rasterize(content(), 1920);
  cache.set(a.key, a);
  const hit = cache.get(a.key);

  const b = await rasterizer.rasterize(content({ text: 'different' }), 1920);
  cache.set(b.key, b);

  // The first sweep evicts nothing: `set` marks an entry touched, so a just-created texture cannot be
  // swept before it has been used once — otherwise a clip would re-rasterize on every sweep tick.
  cache.sweep();
  const sizeAfterFirstSweep = cache.size();

  // Second sweep with only one entry touched: the other must go.
  cache.get(a.key);
  cache.sweep();

  results.cache = {
    hitIsSameObject: hit === a,
    keysDiffer: a.key !== b.key,
    sizeAfterFirstSweep,
    sizeAfterSweep: cache.size(),
    survivorIsTouched: cache.get(a.key) !== undefined,
  };
}

(window as unknown as { __rastercheck: unknown }).__rastercheck = results;
