import type { RgbaColor, TextContent } from '@nos/core';
import {
  type RasterizedText,
  type TextRasterCache,
  type TextRasterizer,
  contentCacheKey,
} from '../contracts/text-raster.js';
import { buildAdvances, wrapText } from './typewriter.js';
import { clamp01 } from '@nos/core';

/**
 * Canvas 2D text rasterization.
 *
 * The one place in the text layer that needs a real canvas, which is why everything else — wrapping,
 * advances, the typewriter, the presets — was kept pure and tested separately. What remains here is glyph
 * measurement and drawing.
 *
 * ## Why measurement goes through the same helpers as layout
 *
 * `buildAdvances` and `wrapText` take measurement functions rather than doing it themselves. That is not
 * indirection for its own sake: preview and export must reveal the *same characters at the same time*, so
 * both paths have to produce identical advances. Sharing the layout code and injecting only the
 * measurement makes that structural rather than a coincidence.
 */

export interface CanvasRasterizerOptions {
  /**
   * Creates a drawing surface.
   *
   * Injected so the renderer can use `OffscreenCanvas` (which keeps rasterization off the main thread)
   * while a test or a headless export path supplies something else.
   */
  readonly createCanvas: (width: number, height: number) => OffscreenCanvas | HTMLCanvasElement;
  /**
   * Device pixel ratio to rasterize at.
   *
   * Text rasterized at 1x and scaled up is visibly soft, and titles are the one element a viewer reads
   * rather than glances at. Capped by the caller, since a 3x ratio on a 4K output is a very large texture.
   */
  readonly pixelRatio?: number;
}

/** Padding around the text box, so outlines and shadows are not clipped at the texture edge. */
const EDGE_PADDING = 8;

export function createCanvasRasterizer(options: CanvasRasterizerOptions): TextRasterizer {
  const pixelRatio = Math.max(1, Math.min(options.pixelRatio ?? 1, 3));

  return {
    async rasterize(content: TextContent, maxWidth: number): Promise<RasterizedText> {
      // A scratch surface for measurement, before the real dimensions are known. One pixel is enough:
      // `measureText` does not depend on canvas size.
      const scratch = options.createCanvas(1, 1);
      const scratchContext = get2d(scratch);
      applyFont(scratchContext, content, pixelRatio);

      const measureLine = (text: string): number =>
        measureWithSpacing(scratchContext, text, content.letterSpacing * pixelRatio);
      const measureCharacter = (character: string): number => scratchContext.measureText(character).width;

      const scaledMaxWidth = maxWidth * pixelRatio;
      const lines = wrapText(content.text, scaledMaxWidth, measureLine);

      const lineHeightPx = content.size * pixelRatio * content.lineHeight;
      const widest = lines.reduce((widest, line) => Math.max(widest, measureLine(line)), 0);
      const boxWidth = Math.min(Math.max(widest, 1), scaledMaxWidth || widest || 1);

      const advances = buildAdvances(lines, {
        measureCharacter,
        measureLine,
        fontSize: content.size * pixelRatio,
        lineHeight: content.lineHeight,
        letterSpacing: content.letterSpacing * pixelRatio,
        align: content.align,
        boxWidth,
      });

      const padding = EDGE_PADDING * pixelRatio + outlineExtent(content, pixelRatio);
      const width = Math.ceil(boxWidth + padding * 2);
      // An extra line height below the last baseline leaves room for descenders.
      const height = Math.ceil(lineHeightPx * (lines.length + 0.35) + padding * 2);

      const canvas = options.createCanvas(width, height);
      const context = get2d(canvas);
      applyFont(context, content, pixelRatio);
      context.textBaseline = 'alphabetic';
      context.textAlign = 'left';

      if (content.shadow !== undefined) {
        context.shadowOffsetX = content.shadow.offsetX * pixelRatio;
        context.shadowOffsetY = content.shadow.offsetY * pixelRatio;
        context.shadowBlur = content.shadow.blur * pixelRatio;
        context.shadowColor = toCss(content.shadow.color);
      }

      for (const line of advances.lines) {
        const x = padding + line.originX;
        const y = padding + line.baselineY;

        // Outline first, so the fill sits on top of it rather than being half-covered — stroking after
        // filling eats into the glyph and thins the letterforms.
        if (content.outline !== undefined && content.outline.width > 0) {
          context.lineWidth = content.outline.width * 2 * pixelRatio;
          context.strokeStyle = toCss(content.outline.color);
          context.lineJoin = 'round';
          drawWithSpacing(context, line.text, x, y, content.letterSpacing * pixelRatio, 'stroke');
        }

        context.fillStyle = toCss(content.color);
        // The shadow is drawn with the outline when there is one; disabling it for the fill avoids a
        // second, doubled shadow.
        if (content.outline !== undefined && content.shadow !== undefined) {
          context.shadowColor = 'transparent';
        }
        drawWithSpacing(context, line.text, x, y, content.letterSpacing * pixelRatio, 'fill');
      }

      return {
        key: contentCacheKey(content, maxWidth),
        width,
        height,
        image: canvas,
        advances,
      };
    },
  };
}

/**
 * Draws text with explicit letter spacing.
 *
 * `ctx.letterSpacing` exists but is not universally supported and, more importantly, it would make the
 * drawn positions disagree with the advances computed above. Drawing character by character at the
 * positions the advance table describes guarantees the two agree, which is what the typewriter clip
 * depends on.
 */
function drawWithSpacing(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number,
  mode: 'fill' | 'stroke',
): void {
  if (letterSpacing === 0) {
    if (mode === 'fill') context.fillText(text, x, y);
    else context.strokeText(text, x, y);
    return;
  }

  let cursor = x;
  for (const character of text) {
    if (mode === 'fill') context.fillText(character, cursor, y);
    else context.strokeText(character, cursor, y);
    cursor += context.measureText(character).width + letterSpacing;
  }
}

function measureWithSpacing(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  letterSpacing: number,
): number {
  if (letterSpacing === 0) return context.measureText(text).width;
  // Summed per character to match how it is drawn; `measureText` on the whole string applies kerning that
  // per-character drawing does not, and the two would disagree by a pixel per glyph.
  let total = 0;
  for (const character of text) {
    total += context.measureText(character).width + letterSpacing;
  }
  return Math.max(0, total - letterSpacing);
}

function applyFont(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  content: TextContent,
  pixelRatio: number,
): void {
  context.font = `${content.weight} ${content.size * pixelRatio}px ${content.font}`;
}

/** Extra room an outline needs beyond the glyph bounds. */
function outlineExtent(content: TextContent, pixelRatio: number): number {
  return content.outline === undefined ? 0 : content.outline.width * pixelRatio * 2;
}

function toCss(color: RgbaColor): string {
  const channel = (value: number): number => Math.round(clamp01(value) * 255);
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${clamp01(color.a)})`;
}

function get2d(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('a 2D canvas context could not be created');
  }
  return context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

/**
 * A rasterization cache with mark-and-sweep eviction.
 *
 * Rasterized text is large — a 1080p-wide title is several megabytes — so entries cannot accumulate for a
 * session. Sweeping on a caller-driven tick rather than an LRU with a fixed capacity, because the useful
 * working set is "the clips near the playhead", which changes shape as the user navigates and is not well
 * described by a count.
 */
export function createTextRasterCache(): TextRasterCache {
  const entries = new Map<string, RasterizedText>();
  let touched = new Set<string>();

  return {
    get(key: string): RasterizedText | undefined {
      const entry = entries.get(key);
      if (entry !== undefined) touched.add(key);
      return entry;
    },

    set(key: string, raster: RasterizedText): void {
      entries.set(key, raster);
      touched.add(key);
    },

    sweep(): void {
      for (const key of [...entries.keys()]) {
        if (!touched.has(key)) entries.delete(key);
      }
      touched = new Set();
    },

    size: () => entries.size,

    dispose(): void {
      entries.clear();
      touched = new Set();
    },
  };
}
