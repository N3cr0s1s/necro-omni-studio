import { describe, expect, it } from 'vitest';
import type { TextContent } from '@nos/core';
import { contentCacheKey, keyInputFrom, rasterCacheKey } from './text-raster.js';

function content(overrides: Partial<TextContent> = {}): TextContent {
  return {
    text: 'A rendszer',
    font: 'Inter',
    size: 72,
    weight: 700,
    color: { r: 0.9, g: 0.75, b: 0.49, a: 1 },
    align: 'center',
    lineHeight: 1.2,
    letterSpacing: 0,
    ...overrides,
  };
}

const key = (overrides: Partial<TextContent> = {}, maxWidth = 1920): string =>
  contentCacheKey(content(overrides), maxWidth);

describe('cache key stability', () => {
  it('is stable for identical content', () => {
    expect(key()).toBe(key());
  });

  it('is shared by two clips with identical styling', () => {
    // Common when a lower third repeats through a piece; they should share one texture.
    expect(contentCacheKey(content(), 1920)).toBe(contentCacheKey(content(), 1920));
  });

  it('stays readable, so a cache entry can be identified by eye', () => {
    expect(key()).toContain('Inter');
    expect(key()).toContain('72');
  });
});

describe('properties that must change the key', () => {
  it('changes with the text', () => {
    expect(key()).not.toBe(key({ text: 'Something else' }));
  });

  it('changes with font, size and weight', () => {
    expect(key()).not.toBe(key({ font: 'Georgia' }));
    expect(key()).not.toBe(key({ size: 48 }));
    expect(key()).not.toBe(key({ weight: 400 }));
  });

  it('changes with colour', () => {
    expect(key()).not.toBe(key({ color: { r: 1, g: 1, b: 1, a: 1 } }));
  });

  it('changes with outline and shadow', () => {
    expect(key()).not.toBe(key({ outline: { width: 2, color: { r: 0, g: 0, b: 0, a: 1 } } }));
    expect(key()).not.toBe(
      key({ shadow: { offsetX: 0, offsetY: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.5 } } }),
    );
  });

  it('changes with alignment, which moves glyphs in the texture', () => {
    expect(key()).not.toBe(key({ align: 'left' }));
  });

  it('changes with letter spacing and line height, which alter layout', () => {
    // The spec lists both as keyframable, but both change glyph layout, so animating either genuinely
    // re-rasterizes. Including them is honest; excluding them would render stale pixels.
    expect(key()).not.toBe(key({ letterSpacing: 0.05 }));
    expect(key()).not.toBe(key({ lineHeight: 1.6 }));
  });

  it('changes with the wrapping width, which changes line breaks', () => {
    expect(key({}, 1920)).not.toBe(key({}, 960));
  });
});

describe('properties that must not change the key', () => {
  it('ignores the transform channels, so an animated clip rasterizes once', () => {
    // The whole point of the rule: position, scale, rotation and opacity apply as a transform, so a text
    // clip moving across the frame must not re-rasterize per frame.
    const input = keyInputFrom(content(), 1920);
    expect(Object.keys(input)).not.toContain('x');
    expect(Object.keys(input)).not.toContain('y');
    expect(Object.keys(input)).not.toContain('scale');
    expect(Object.keys(input)).not.toContain('rotation');
    expect(Object.keys(input)).not.toContain('opacity');
  });
});

describe('collision resistance', () => {
  it('distinguishes a long text from its own prefix', () => {
    // The text is truncated in the key, so its full length must be included or a paragraph and its
    // opening sentence would collide.
    const long = 'x'.repeat(200);
    expect(key({ text: long })).not.toBe(key({ text: long.slice(0, 48) }));
  });

  it('distinguishes two long texts differing only past the truncation point', () => {
    // Length plus a readable prefix is not enough: a paragraph and an edited version of it share both.
    // A colliding key renders the wrong text from cache, which the symptom gives no clue about.
    const base = 'y'.repeat(100);
    expect(key({ text: `${base}A` })).not.toBe(key({ text: `${base}B` }));
  });

  it('distinguishes texts differing only in the middle', () => {
    const make = (middle: string) => `${'a'.repeat(60)}${middle}${'b'.repeat(60)}`;
    expect(key({ text: make('X') })).not.toBe(key({ text: make('Y') }));
  });

  it('distinguishes a transposition, which a weak hash would miss', () => {
    expect(key({ text: 'abcdef' })).not.toBe(key({ text: 'abcdfe' }));
  });

  it('normalizes whitespace in the readable part without losing the distinction', () => {
    // Newlines in a key would make it unreadable in a log; length still separates the two.
    expect(key({ text: 'a\nb' })).not.toContain('\n');
    expect(key({ text: 'a\nb' })).not.toBe(key({ text: 'ab' }));
  });

  it('is bounded in length whatever the text', () => {
    const huge = 'z'.repeat(100_000);
    expect(key({ text: huge }).length).toBeLessThan(300);
  });
});

describe('float tolerance', () => {
  it('ignores colour differences below display precision', () => {
    // A float that arrived as 0.30000000000000004 must not produce a distinct cache entry.
    const a = key({ color: { r: 0.3, g: 0.5, b: 0.2, a: 1 } });
    const b = key({ color: { r: 0.3 + Number.EPSILON, g: 0.5, b: 0.2, a: 1 } });
    expect(a).toBe(b);
  });

  it('still distinguishes visible colour differences', () => {
    expect(key({ color: { r: 0.3, g: 0.5, b: 0.2, a: 1 } })).not.toBe(
      key({ color: { r: 0.35, g: 0.5, b: 0.2, a: 1 } }),
    );
  });
});

describe('rasterCacheKey', () => {
  it('accepts a bare key input without a clip', () => {
    const built = rasterCacheKey({
      text: 'hi',
      font: 'Inter',
      size: 24,
      weight: 400,
      color: { r: 1, g: 1, b: 1, a: 1 },
      outline: undefined,
      shadow: undefined,
      align: 'left',
      lineHeight: 1.2,
      letterSpacing: 0,
      maxWidth: 800,
    });
    expect(built).toContain('Inter');
    expect(built).toContain('onone');
  });
});
