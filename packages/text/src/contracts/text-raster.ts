import type { TextContent } from '@nos/core';

/**
 * Text rasterization.
 *
 * The spec's rule is that an animated text clip rasterizes **once for its whole duration**: the texture
 * cache key covers only the non-animatable properties, and the animatable ones (`x`, `y`, `scale`,
 * `rotation`, `opacity`) apply as a transform. Without that rule a text clip with a moving position would
 * re-rasterize every frame, which at 1080p is far too slow to hold the spec's 16 ms budget.
 *
 * `letterSpacing` and `lineHeight` are the awkward pair: the spec lists them as keyframable, but both
 * change glyph *layout*, so animating either genuinely does require re-rasterization. They are therefore
 * part of the cache key, and animating them is honestly slower — documented rather than silently
 * degraded.
 */

/** The layout produced by rasterizing, used by the typewriter mechanism. */
export interface GlyphAdvances {
  /**
   * Cumulative x offset after each character, in texture pixels, per line.
   *
   * Cumulative rather than per-glyph widths because the typewriter needs "where does the Nth character
   * end", which is a prefix sum — computing it per frame from widths would be O(n) every frame for no
   * reason.
   */
  readonly lines: readonly LineAdvances[];
  /** Total characters across all lines, so a reveal fraction maps to a count. */
  readonly totalCharacters: number;
}

export interface LineAdvances {
  /** Character index in the source string where this line begins. */
  readonly startIndex: number;
  readonly text: string;
  /** `advances[i]` is the x offset after character `i`. Length equals `text.length`. */
  readonly advances: readonly number[];
  /** Baseline y of this line in the texture, in pixels. */
  readonly baselineY: number;
  /** Left edge of the line, accounting for alignment. */
  readonly originX: number;
  readonly width: number;
}

export interface RasterizedText {
  /** Cache key this was produced for. */
  readonly key: string;
  readonly width: number;
  readonly height: number;
  /** The rendered pixels. `ImageBitmap` in a browser; the executor uploads it as a texture. */
  readonly image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
  readonly advances: GlyphAdvances;
}

export type TextRasterError =
  | { readonly kind: 'no-canvas'; readonly detail: string }
  | { readonly kind: 'font-unavailable'; readonly font: string }
  | { readonly kind: 'too-large'; readonly width: number; readonly height: number };

/**
 * Rasterizes text to a texture.
 *
 * An interface because there are genuinely different implementations: Canvas 2D in the renderer, and a
 * headless path for export if it ever runs outside a window. Both must produce identical advances or the
 * typewriter would reveal different characters in preview and export.
 */
export interface TextRasterizer {
  rasterize(content: TextContent, maxWidth: number): Promise<RasterizedText>;
}

/**
 * Caches rasterized text.
 *
 * Keyed by the content hash, so two clips with identical styling share one texture — common when a lower
 * third repeats through a piece.
 */
export interface TextRasterCache {
  get(key: string): RasterizedText | undefined;
  set(key: string, raster: RasterizedText): void;
  /** Drops entries not touched since the last sweep, bounding memory over a long session. */
  sweep(): void;
  size(): number;
  dispose(): void;
}

/**
 * Properties that affect the rendered pixels.
 *
 * Exactly this set forms the cache key. Getting it wrong in either direction is bad: too narrow and a
 * style change would show stale pixels, too wide and an animated clip would re-rasterize per frame.
 */
export interface RasterKeyInput {
  readonly text: string;
  readonly font: string;
  readonly size: number;
  readonly weight: number;
  readonly color: TextContent['color'];
  readonly outline: TextContent['outline'];
  readonly shadow: TextContent['shadow'];
  readonly align: TextContent['align'];
  readonly lineHeight: number;
  readonly letterSpacing: number;
  /** Wrapping width affects line breaks, so it is part of the key. */
  readonly maxWidth: number;
}

/**
 * Builds the rasterization cache key.
 *
 * A readable composite rather than a hash: cache keys show up in debugging, and `Inter-72-700-...` tells
 * you what you are looking at where a hex digest does not. Length is bounded by truncating the text,
 * which is the only unbounded field, and including its full length so two texts sharing a prefix cannot
 * collide.
 */
export function rasterCacheKey(input: RasterKeyInput): string {
  const colour = `${round(input.color.r)},${round(input.color.g)},${round(input.color.b)},${round(input.color.a)}`;
  const outline =
    input.outline === undefined ? 'none' : `${input.outline.width}:${round(input.outline.color.a)}`;
  const shadow =
    input.shadow === undefined
      ? 'none'
      : `${input.shadow.offsetX},${input.shadow.offsetY},${input.shadow.blur}`;

  // The text contributes three things: its length, a hash of the *whole* string, and a readable prefix.
  //
  // The hash is not optional. Length plus prefix alone collides for two long texts that differ only past
  // the truncation point — a paragraph and an edited version of it — and a colliding key renders the
  // wrong text from cache, which is close to impossible to diagnose from the symptom.
  const textPart = `${input.text.length}:${hashString(input.text)}:${input.text
    .slice(0, 32)
    .replace(/\s+/g, ' ')}`;

  return [
    input.font,
    input.size,
    input.weight,
    colour,
    `o${outline}`,
    `s${shadow}`,
    input.align,
    `lh${input.lineHeight}`,
    `ls${input.letterSpacing}`,
    `w${Math.round(input.maxWidth)}`,
    textPart,
  ].join('|');
}

/**
 * FNV-1a, 32-bit.
 *
 * Not cryptographic and does not need to be: this only has to separate texts a user might plausibly have
 * in one project. It is a few lines, allocation-free, and avoids pulling a hashing dependency into a
 * package that otherwise needs none.
 */
function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // The FNV prime, expressed as shifts so the multiply stays inside 32 bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}

function round(value: number): number {
  // Two decimals: colour differences below that are not representable in 8-bit output anyway, and
  // rounding keeps a float that arrived as 0.30000000000000004 from producing a distinct key.
  return Math.round(value * 100) / 100;
}

/** Extracts the key input from a text clip's content. */
export function keyInputFrom(content: TextContent, maxWidth: number): RasterKeyInput {
  return {
    text: content.text,
    font: content.font,
    size: content.size,
    weight: content.weight,
    color: content.color,
    ...(content.outline !== undefined ? { outline: content.outline } : { outline: undefined }),
    ...(content.shadow !== undefined ? { shadow: content.shadow } : { shadow: undefined }),
    align: content.align,
    lineHeight: content.lineHeight,
    letterSpacing: content.letterSpacing,
    maxWidth,
  };
}

/** Convenience: cache key straight from a clip's content. */
export function contentCacheKey(content: TextContent, maxWidth: number): string {
  return rasterCacheKey(keyInputFrom(content, maxWidth));
}
