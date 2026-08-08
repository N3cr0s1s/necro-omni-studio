/**
 * Arithmetic that several layers need to agree about.
 *
 * Small enough to write inline, which is exactly why it kept being written inline — and why the four
 * copies of `clamp01` had already drifted before anyone noticed: three refused a non-finite value and
 * the fourth passed it straight through, so the same call returned `0` in the compositor and `NaN` in
 * the segmentation panel. Nothing was broken by it, because the one caller that could produce `NaN`
 * guarded separately, which is precisely the kind of accident that stops being an accident later.
 */

/**
 * A value pinned to `[0, 1]`.
 *
 * A non-finite input is **zero**, not `NaN`. These clamp normalised things — an opacity, a progress, a
 * click position as a fraction of a box — and every one of them is read by something that cannot
 * represent `NaN`: a shader uniform silently blanks the frame it is drawing, and a mask prompt at
 * `NaN` is a point no propagation can start from. Zero is wrong in a way the user can see and undo.
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A value pinned between two bounds, with the same treatment of a non-finite input. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
