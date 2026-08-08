import {
  type Rational,
  divide,
  equals,
  formatRational,
  parseRational,
  rational,
  round,
  toNumber,
} from './rational.js';

/**
 * A frame rate, held exactly.
 *
 * Distinct from a bare `Rational` so a duration can never be passed where a rate
 * belongs; the `frames` brand on `FrameIndex` closes the other half of that gap.
 */
export interface FrameRate {
  readonly kind: 'frame-rate';
  readonly value: Rational;
}

export function frameRate(numerator: number, denominator = 1): FrameRate {
  const value = rational(numerator, denominator);
  if (value.numerator <= 0) {
    throw new RangeError(`Frame rate must be positive, received ${formatRational(value)}`);
  }
  return { kind: 'frame-rate', value };
}

export function parseFrameRate(text: string): FrameRate {
  const value = parseRational(text);
  if (value.numerator <= 0) {
    throw new RangeError(`Frame rate must be positive, received ${text}`);
  }
  return { kind: 'frame-rate', value };
}

export const FRAME_RATES = {
  FILM_24: frameRate(24),
  NTSC_FILM_23_976: frameRate(24000, 1001),
  PAL_25: frameRate(25),
  NTSC_29_97: frameRate(30000, 1001),
  WEB_30: frameRate(30),
  PAL_HD_50: frameRate(50),
  NTSC_HD_59_94: frameRate(60000, 1001),
  WEB_60: frameRate(60),
} as const satisfies Record<string, FrameRate>;

export function frameRateEquals(a: FrameRate, b: FrameRate): boolean {
  return equals(a.value, b.value);
}

export function frameRateToNumber(rate: FrameRate): number {
  return toNumber(rate.value);
}

export function formatFrameRate(rate: FrameRate): string {
  return formatRational(rate.value);
}

/**
 * Human-facing rate label: `29.97` rather than `30000/1001`.
 *
 * Trailing zeros are trimmed so integer rates read as `30`, not `30.00`.
 */
export function displayFrameRate(rate: FrameRate): string {
  const value = toNumber(rate.value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, '');
}

/** Exact duration of one frame, in seconds. */
export function frameDuration(rate: FrameRate): Rational {
  return divide(rational(1), rate.value);
}

/**
 * Whether timecode for this rate is conventionally drop-frame.
 *
 * True for the 1001-denominator rates at 30 fps and above, where non-drop timecode
 * would drift ~3.6 s per hour away from wall clock. 23.976 is excluded: film-rate
 * material is conventionally labelled non-drop.
 */
export function isDropFrameRate(rate: FrameRate): boolean {
  if (rate.value.denominator !== 1001) return false;
  // Compare the *nominal* rate, not the real one: 29.97 is below 30, so comparing
  // the exact value here would classify the canonical drop-frame rate as non-drop.
  return nominalRate(rate) >= 30;
}

/**
 * The nominal integer rate used for timecode arithmetic — 30 for 29.97, 60 for
 * 59.94, 24 for 23.976. Timecode counts labels, not real frames.
 */
export function nominalRate(rate: FrameRate): number {
  return round(rate.value);
}
