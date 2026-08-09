import { type Result, err, ok } from '@nos/core';

/**
 * Reading a palette as numbers, so a theme can be checked rather than admired.
 *
 * A palette is thirty-one strings, and strings are exactly as legible as their author guessed. The
 * only way to know whether text can be read on a surface is to measure it, and measuring means
 * turning `oklch(0.145 0 0)` into a luminance — which is four coordinate changes away.
 *
 * This exists so `themes.test.ts` can assert that every theme this application ships is readable,
 * including the ones nobody has looked at since they were added. That check is the whole reason for
 * the module; nothing draws with these numbers.
 *
 * ## Why the round trip through sRGB
 *
 * OKLCH describes more colours than a screen can show. Converting straight to a luminance would score
 * a colour by what it *specifies* rather than by what a user sees, and the two part company exactly
 * where palettes get bold. So the path is oklch → oklab → linear sRGB → **clipped to the display
 * gamut** → encoded to sRGB, and the clip is the step that makes the answer honest.
 *
 * `Srgb` is where that path stops, because it is the space a browser composites and a screen shows.
 * Luminance goes back to linear light on the way out, which is WCAG's definition; the first version of
 * this module skipped the encode and so linearized everything twice.
 */

/** A colour with its coordinates read out. Alpha is 1 unless the source said otherwise. */
export interface Oklch {
  /** Perceptual lightness, 0 to 1. */
  readonly l: number;
  /** Chroma, 0 upwards; 0 is a neutral grey. */
  readonly c: number;
  /** Hue in degrees. Meaningless at zero chroma, and zero there by convention. */
  readonly h: number;
  /** 0 to 1. Values below 1 must be composited before they mean anything. */
  readonly alpha: number;
}

export type ColorProblem = { readonly kind: 'unreadable'; readonly value: string };

/**
 * Reads `oklch(L C H)` or `oklch(L C H / A)`, with either component allowed a percent sign.
 *
 * A `Result` rather than a throw or a default: a palette value this cannot read is a mistake in the
 * palette, and answering with black would let a theme ship that is measured as something it is not.
 * Every caller here is a test, and a test that fails loudly is the point.
 */
export function parseOklch(value: string): Result<Oklch, ColorProblem> {
  const match = /^oklch\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)\s*(?:\/\s*([^\s/]+)\s*)?\)$/i.exec(
    value.trim(),
  );
  if (match === null) return err({ kind: 'unreadable', value });

  const [, rawL, rawC, rawH, rawAlpha] = match;
  const l = numberOrPercent(rawL, 1);
  const c = numberOrPercent(rawC, 0.4);
  // A bare hue is degrees; `none` is how CSS spells "no hue", which a grey is entitled to.
  const h = rawH === 'none' ? 0 : Number.parseFloat(rawH ?? '');
  const alpha = rawAlpha === undefined ? 1 : numberOrPercent(rawAlpha, 1);

  if (![l, c, h, alpha].every((n) => Number.isFinite(n))) return err({ kind: 'unreadable', value });
  return ok({ l, c, h, alpha });
}

/**
 * `50%` against the given full-scale value, or a bare number as-is.
 *
 * Chroma's full scale is 0.4 rather than 1, which is CSS's rule and not an approximation — a palette
 * written with percentages would otherwise be read an order of magnitude too saturated.
 */
function numberOrPercent(raw: string | undefined, full: number): number {
  if (raw === undefined) return Number.NaN;
  return raw.endsWith('%') ? (Number.parseFloat(raw) / 100) * full : Number.parseFloat(raw);
}

/**
 * Red, green and blue in 0…1, gamma-encoded — the numbers a stylesheet and a screen deal in.
 *
 * Encoded rather than linear, and the distinction is not pedantry: the first version of this returned
 * the matrix's linear output and then handed it to `relativeLuminance`, which linearizes. Every colour
 * was linearized twice, every dark colour scored far darker than it is, and the contrast checks failed
 * on palettes shadcn publishes — which is what exposed it. A conversion that is wrong by a gamma curve
 * still returns a plausible colour for every input, so the only thing that catches it is a number
 * checked against an outside source.
 */
export interface Srgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * OKLCH to displayable sRGB, by Ottosson's matrices.
 *
 * The clamp at the end is a gamut clip, and it is where a colour stops being a specification and
 * becomes what a screen does. Clipping each channel on its own is the crude version — it shifts hue
 * on very saturated colours — but it is what browsers did for years and it is conservative in the
 * direction that matters here: a clipped colour reads as *less* contrasty than the specification, so
 * a palette that passes this check passes on a real screen too.
 */
export function oklchToSrgb(color: Oklch): Srgb {
  const radians = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(radians);
  const b = color.c * Math.sin(radians);

  const lRoot = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = color.l - 0.0894841775 * a - 1.291485548 * b;

  const long = lRoot * lRoot * lRoot;
  const medium = mRoot * mRoot * mRoot;
  const short = sRoot * sRoot * sRoot;

  // Clipped in linear light and *then* encoded, in that order: gamma encoding is undefined for a
  // negative channel, and it is monotonic on 0…1 so clipping first costs nothing.
  return {
    r: encode(clamp01(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short)),
    g: encode(clamp01(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short)),
    b: encode(clamp01(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short)),
  };
}

/** Linear light to the sRGB transfer function's output. The exact inverse of `toLinear`. */
function encode(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function clamp01(value: number): number {
  // Written to reject `NaN` rather than pass it through: the three copies of this that had already
  // drifted in this repository differed on exactly that, and a silent `NaN` here scores a palette as
  // perfectly contrasty.
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * A translucent colour drawn over an opaque one.
 *
 * Blended on the **encoded** channels, because that is what a browser does when it paints a
 * translucent border: CSS compositing is defined in the destination colour space, and this module
 * exists to predict what a user sees rather than what a colour scientist would prefer. shadcn's dark
 * palettes give `border` and `input` an alpha, so without this those two would be measured as though
 * they were opaque white.
 */
export function over(top: Srgb, bottom: Srgb, alpha: number): Srgb {
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  };
}

/** WCAG relative luminance, from linear-light channels. */
export function relativeLuminance(color: Srgb): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * The WCAG ratio between two luminances, always at least 1 and at most 21.
 *
 * Ordered by brightness rather than by argument, so a caller cannot get a contrast of 0.3 by naming
 * the pair the other way round — a mistake that reads as a failing theme rather than as a bug.
 */
export function contrastRatio(a: Srgb, b: Srgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * How different two colours look, as a distance in OKLab.
 *
 * A separate question from contrast, and the first version of this module conflated them. WCAG's
 * ratio is a function of luminance alone, so it scores an orange and a teal of equal brightness at
 * 1.02 — which reads as "these two categories are indistinguishable" about a pair nobody could
 * confuse. Two of shadcn's chart ramps are exactly that pair, which is how the mistake surfaced.
 *
 * OKLab exists for this: it is a space built so that Euclidean distance tracks perceived difference.
 * Roughly, 0.02 is around the threshold of noticing and 0.1 is comfortably different.
 */
export function oklabDistance(a: Oklch, b: Oklch): number {
  const first = toOklab(a);
  const second = toOklab(b);
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b);
}

function toOklab(color: Oklch): { l: number; a: number; b: number } {
  const radians = (color.h * Math.PI) / 180;
  return { l: color.l, a: color.c * Math.cos(radians), b: color.c * Math.sin(radians) };
}

/** `oklabDistance` for two palette values, reporting whichever one it could not read. */
export function paletteDistance(a: string, b: string): Result<number, ColorProblem> {
  const first = parseOklch(a);
  if (!first.ok) return first;
  const second = parseOklch(b);
  if (!second.ok) return second;
  return ok(oklabDistance(first.value, second.value));
}

/**
 * Contrast between two palette values, compositing the foreground if it is translucent.
 *
 * The background is required to be opaque, because in this application it always is: every surface
 * role — `background`, `card`, `popover`, `primary` — is a solid colour, and only the hairlines drawn
 * over them carry alpha. A translucent background would need to know what is behind *it*, which is a
 * question a palette cannot answer.
 */
export function paletteContrast(foreground: string, background: string): Result<number, ColorProblem> {
  const front = parseOklch(foreground);
  if (!front.ok) return front;
  const back = parseOklch(background);
  if (!back.ok) return back;

  const backSrgb = oklchToSrgb(back.value);
  const frontSrgb =
    front.value.alpha >= 1
      ? oklchToSrgb(front.value)
      : over(oklchToSrgb(front.value), backSrgb, front.value.alpha);

  return ok(contrastRatio(frontSrgb, backSrgb));
}
