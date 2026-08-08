/**
 * Exact rational arithmetic over `number`.
 *
 * Frame rates are rationals (29.97 is 30000/1001, not 29.97), and the spec requires
 * frame-exact time everywhere. Doing that in floating point accumulates drift that
 * shows up as a one-frame slip after a few minutes of timeline, so every conversion
 * routes through integer numerator/denominator pairs and only collapses to a float
 * at the very edge — display, or a WebGL uniform.
 *
 * Numerators and denominators stay well inside `Number.MAX_SAFE_INTEGER` for any
 * realistic project (rates are small integers over small integers, and durations are
 * bounded by the 3-minute target), and every constructor normalizes by the GCD so
 * repeated arithmetic cannot grow them without bound.
 */
export interface Rational {
  /** Signed. */
  readonly numerator: number;
  /** Strictly positive after normalization. */
  readonly denominator: number;
}

export class RationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RationalError';
  }
}

/**
 * Builds a normalized rational. Sign is carried by the numerator, the fraction is
 * reduced, and both parts must be integers — a non-integer here means a float leaked
 * into the time layer, which is exactly the bug this module exists to prevent.
 */
export function rational(numerator: number, denominator = 1): Rational {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new RationalError(`Rational parts must be integers, received ${numerator}/${denominator}`);
  }
  if (denominator === 0) {
    throw new RationalError('Rational denominator must not be zero');
  }
  const sign = denominator < 0 ? -1 : 1;
  const signedNumerator = numerator * sign;
  const absDenominator = Math.abs(denominator);
  const divisor = gcd(Math.abs(signedNumerator), absDenominator);
  return {
    numerator: signedNumerator / divisor,
    denominator: absDenominator / divisor,
  };
}

export const RATIONAL_ZERO: Rational = { numerator: 0, denominator: 1 };
export const RATIONAL_ONE: Rational = { numerator: 1, denominator: 1 };

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

export function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs(a / gcd(a, b)) * Math.abs(b);
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

export function subtract(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
}

export function multiply(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function divide(a: Rational, b: Rational): Rational {
  if (b.numerator === 0) {
    throw new RationalError('Division by zero rational');
  }
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}

export function negate(a: Rational): Rational {
  return { numerator: -a.numerator, denominator: a.denominator };
}

export function reciprocal(a: Rational): Rational {
  if (a.numerator === 0) {
    throw new RationalError('Zero has no reciprocal');
  }
  return rational(a.denominator, a.numerator);
}

/** Returns a negative number, zero, or a positive number, like a sort comparator. */
export function compare(a: Rational, b: Rational): number {
  return a.numerator * b.denominator - b.numerator * a.denominator;
}

export function equals(a: Rational, b: Rational): boolean {
  return compare(a, b) === 0;
}

export function isZero(a: Rational): boolean {
  return a.numerator === 0;
}

export function toNumber(a: Rational): number {
  return a.numerator / a.denominator;
}

/** Largest integer `n` with `n <= a`. */
export function floor(a: Rational): number {
  return Math.floor(a.numerator / a.denominator);
}

/** Smallest integer `n` with `n >= a`. */
export function ceil(a: Rational): number {
  // `Math.ceil(-0.5)` is `-0`, which is a frame index that fails `Object.is` against
  // `0` and can flip a sign check downstream. Normalize it away at the source.
  return normalizeZero(Math.ceil(a.numerator / a.denominator));
}

/**
 * Rounds half away from zero.
 *
 * Deliberately not banker's rounding: frame conversions land on exact halves often
 * (a 0.5 s cut at 30 fps), and alternating tie direction would make the same edit
 * produce different frames depending on its position.
 */
export function round(a: Rational): number {
  const quotient = a.numerator / a.denominator;
  return normalizeZero(quotient < 0 ? -Math.round(-quotient) : Math.round(quotient));
}

/** Collapses `-0` to `0`; every other value passes through untouched. */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Parses `"30"`, `"30/1"`, `"30000/1001"`, or a decimal like `"29.97"`.
 *
 * Decimals that match a known broadcast rate snap to their exact rational form:
 * a project authored as "29.97" means 30000/1001, and treating it literally as
 * 2997/100 would drift by a frame every ~17 minutes.
 */
export function parseRational(text: string): Rational {
  const trimmed = text.trim();
  const slash = trimmed.indexOf('/');
  if (slash >= 0) {
    const numerator = Number(trimmed.slice(0, slash));
    const denominator = Number(trimmed.slice(slash + 1));
    return rational(numerator, denominator);
  }
  const asNumber = Number(trimmed);
  if (!Number.isFinite(asNumber)) {
    throw new RationalError(`Cannot parse rational from ${JSON.stringify(text)}`);
  }
  return fromNumber(asNumber);
}

/**
 * Converts a float to a rational, snapping to exact broadcast rates.
 *
 * Anything else is expanded by its decimal places (2 -> 2/1, 23.5 -> 47/2), which is
 * exact for the values a user can actually type.
 */
export function fromNumber(value: number): Rational {
  if (!Number.isFinite(value)) {
    throw new RationalError(`Cannot represent ${value} as a rational`);
  }
  for (const candidate of BROADCAST_RATIONALS) {
    if (Math.abs(toNumber(candidate) - value) < 1e-4) return candidate;
  }
  if (Number.isInteger(value)) return rational(value);
  const decimals = countDecimals(value);
  const scale = 10 ** decimals;
  return rational(Math.round(value * scale), scale);
}

export function formatRational(a: Rational): string {
  return a.denominator === 1 ? String(a.numerator) : `${a.numerator}/${a.denominator}`;
}

/**
 * The NTSC-derived rates whose decimal spellings are lies, plus their integer
 * cousins. Ordered so the closest match wins for ambiguous input.
 */
const BROADCAST_RATIONALS: readonly Rational[] = [
  { numerator: 24000, denominator: 1001 }, // 23.976
  { numerator: 30000, denominator: 1001 }, // 29.97
  { numerator: 60000, denominator: 1001 }, // 59.94
  { numerator: 120000, denominator: 1001 }, // 119.88
];

function countDecimals(value: number): number {
  const text = String(value);
  const exponent = text.indexOf('e');
  if (exponent >= 0) {
    // Scientific notation: fall back to a fixed precision we can represent exactly.
    return 9;
  }
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(text.length - dot - 1, 9);
}
