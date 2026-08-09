import { describe, expect, it } from 'vitest';
import { contrastRatio, oklchToSrgb, over, paletteContrast, parseOklch } from './oklch.js';

/**
 * Reading a palette as numbers.
 *
 * Pinned against values that can be checked by hand or against a published table, because a colour
 * conversion is the classic thing that is wrong by a factor nobody notices: every output is a
 * plausible colour, so only an independent number catches it.
 */

function unwrap<T>(result: { ok: boolean; value?: T }): T {
  if (!result.ok) throw new Error('expected a colour');
  return result.value as T;
}

describe('parsing', () => {
  it('reads the three coordinates', () => {
    expect(unwrap(parseOklch('oklch(0.145 0.004 49.3)'))).toEqual({
      l: 0.145,
      c: 0.004,
      h: 49.3,
      alpha: 1,
    });
  });

  it('reads the alpha shadcn uses for hairlines', () => {
    expect(unwrap(parseOklch('oklch(1 0 0 / 10%)')).alpha).toBeCloseTo(0.1, 10);
  });

  it('takes a bare alpha too, which CSS allows', () => {
    expect(unwrap(parseOklch('oklch(1 0 0 / 0.25)')).alpha).toBeCloseTo(0.25, 10);
  });

  it('scales a percentage chroma against 0.4, not 1', () => {
    // CSS's rule. Read against 1 the colour would be ten times as saturated and still parse.
    expect(unwrap(parseOklch('oklch(50% 50% 120)')).c).toBeCloseTo(0.2, 10);
  });

  it('treats `none` as no hue, which a grey is entitled to', () => {
    expect(unwrap(parseOklch('oklch(0.5 0 none)')).h).toBe(0);
  });

  it('refuses anything it cannot read rather than guessing', () => {
    // A default here would score an unreadable palette as a passing one.
    for (const value of ['#ffffff', 'white', 'rgb(0 0 0)', 'oklch(0.5 0.1)', '']) {
      expect(parseOklch(value).ok).toBe(false);
    }
  });
});

describe('to a colour a screen can show', () => {
  it('turns white into white and black into black', () => {
    // Close rather than exact: the matrix's three rows sum to one only to the precision they are
    // written at, so white lands a half-ulp short. Asserting equality here would be asserting that
    // Ottosson rounded his constants the way this test hoped.
    const white = oklchToSrgb({ l: 1, c: 0, h: 0, alpha: 1 });
    for (const channel of [white.r, white.g, white.b]) expect(channel).toBeCloseTo(1, 12);
    expect(oklchToSrgb({ l: 0, c: 0, h: 0, alpha: 1 })).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('puts mid grey where OKLCH says it is', () => {
    // oklch(0.5 0 0) is #636363 — perceptual mid-grey sits well below sRGB's numeric middle. The
    // number is from an outside converter, not from this code, which is the only reason it caught the
    // gamma curve this module was originally missing.
    const grey = oklchToSrgb({ l: 0.5, c: 0, h: 0, alpha: 1 });
    expect(grey.r * 255).toBeCloseTo(99, 0);
    expect(grey.r).toBe(grey.g);
    expect(grey.g).toBe(grey.b);
  });

  it('clips a colour no screen can show instead of returning one out of range', () => {
    // A specification brighter than the display gamut. Left unclipped it would score as more
    // contrasty than it can possibly appear.
    const beyond = oklchToSrgb({ l: 0.9, c: 0.4, h: 140, alpha: 1 });
    for (const channel of [beyond.r, beyond.g, beyond.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});

describe('contrast', () => {
  it('is 21 between black and white, which is the whole scale', () => {
    expect(contrastRatio({ r: 1, g: 1, b: 1 }, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 5);
  });

  it('is 1 between a colour and itself', () => {
    expect(contrastRatio({ r: 0.3, g: 0.6, b: 0.9 }, { r: 0.3, g: 0.6, b: 0.9 })).toBeCloseTo(1, 10);
  });

  it('does not depend on which way round the pair is named', () => {
    // Otherwise a caller could get 0.3 by ordering the arguments differently, which reads as a
    // failing theme rather than as a mistake at the call site.
    const light = { r: 0.9, g: 0.9, b: 0.9 };
    const dark = { r: 0.1, g: 0.1, b: 0.1 };
    expect(contrastRatio(light, dark)).toBeCloseTo(contrastRatio(dark, light), 10);
  });
});

describe('compositing', () => {
  it('at full alpha is the top colour', () => {
    expect(over({ r: 1, g: 0, b: 0 }, { r: 0, g: 0, b: 1 }, 1)).toEqual({ r: 1, g: 0, b: 0 });
  });

  it('at zero alpha is the bottom colour', () => {
    expect(over({ r: 1, g: 0, b: 0 }, { r: 0, g: 0, b: 1 }, 0)).toEqual({ r: 0, g: 0, b: 1 });
  });

  it('is what makes a translucent border measurable at all', () => {
    // shadcn's dark palettes give `border` an alpha of 10%. Measured without compositing it would be
    // scored as pure white — a contrast the user never sees.
    const composited = paletteContrast('oklch(1 0 0 / 10%)', 'oklch(0.145 0 0)');
    const raw = paletteContrast('oklch(1 0 0)', 'oklch(0.145 0 0)');
    expect(unwrap(composited)).toBeLessThan(unwrap(raw));
    expect(unwrap(composited)).toBeGreaterThan(1);
  });

  it('reports the unreadable value rather than scoring it', () => {
    const result = paletteContrast('not a colour', 'oklch(1 0 0)');
    expect(result.ok).toBe(false);
  });
});
