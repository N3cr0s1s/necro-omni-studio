import { type Brand, unsafeBrand } from '../lang/brand.js';
import { type FrameRate, frameRateEquals } from './frame-rate.js';
import { type Rational, divide, multiply, rational, round } from './rational.js';

/**
 * A position on the timeline, counted in whole frames at the project rate.
 *
 * The spec makes this the canonical time unit: seconds exist only at the boundaries
 * (shader uniforms, ffmpeg arguments, what the user reads). Keeping positions and
 * durations in separate brands prevents the classic off-by-one where an exclusive end
 * is used as a duration.
 */
export type FrameIndex = Brand<number, 'FrameIndex'>;

/** A number of frames. Non-negative. */
export type FrameCount = Brand<number, 'FrameCount'>;

export const FRAME_ZERO = 0 as FrameIndex;
export const NO_FRAMES = 0 as FrameCount;

export function frameIndex(value: number): FrameIndex {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Frame index must be an integer, received ${value}`);
  }
  return unsafeBrand<FrameIndex>(value);
}

export function frameCount(value: number): FrameCount {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Frame count must be an integer, received ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`Frame count must not be negative, received ${value}`);
  }
  return unsafeBrand<FrameCount>(value);
}

export function shiftFrames(position: FrameIndex, delta: number): FrameIndex {
  return frameIndex(position + delta);
}

export function advance(position: FrameIndex, count: FrameCount): FrameIndex {
  return frameIndex(position + count);
}

export function framesBetween(from: FrameIndex, to: FrameIndex): FrameCount {
  return frameCount(Math.abs(to - from));
}

/** Exact seconds for a frame position at a given rate. */
export function framesToSeconds(position: FrameIndex | FrameCount, rate: FrameRate): Rational {
  return divide(rational(position as number), rate.value);
}

export function framesToSecondsNumber(
  position: FrameIndex | FrameCount,
  rate: FrameRate,
): number {
  const seconds = framesToSeconds(position, rate);
  return seconds.numerator / seconds.denominator;
}

/**
 * Converts seconds to the nearest frame at a given rate.
 *
 * Rounds rather than truncates: a generator that reports a 4.999999 s output should
 * land on frame 150 at 30 fps, not 149.
 */
export function secondsToFrames(seconds: Rational, rate: FrameRate): FrameIndex {
  return frameIndex(round(multiply(seconds, rate.value)));
}

export function secondsNumberToFrames(seconds: number, rate: FrameRate): FrameIndex {
  return secondsToFrames(rational(Math.round(seconds * 1_000_000), 1_000_000), rate);
}

/**
 * Rebases a frame position from one rate to another.
 *
 * Needed whenever imported media runs at a different rate than the project: the clip
 * keeps its source rate for sample-accurate reads, while the timeline works at the
 * project rate. Identical rates short-circuit so the common case stays exact and free.
 */
export function convertFrames(
  position: FrameIndex,
  from: FrameRate,
  to: FrameRate,
): FrameIndex {
  if (frameRateEquals(from, to)) return position;
  return secondsToFrames(framesToSeconds(position, from), to);
}

/** Rounds a duration up when rebasing, so a converted clip never loses its tail. */
export function convertDurationCeil(
  count: FrameCount,
  from: FrameRate,
  to: FrameRate,
): FrameCount {
  if (frameRateEquals(from, to)) return count;
  const seconds = framesToSeconds(count, from);
  const target = multiply(seconds, to.value);
  return frameCount(Math.ceil(target.numerator / target.denominator));
}

export function clampFrame(position: FrameIndex, min: FrameIndex, max: FrameIndex): FrameIndex {
  if (max < min) {
    throw new RangeError(`Empty clamp range [${min}, ${max}]`);
  }
  return frameIndex(Math.min(Math.max(position, min), max));
}
