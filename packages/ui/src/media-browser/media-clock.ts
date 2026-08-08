/**
 * Times, as a transport shows them.
 *
 * Pure and separate from the component because every interesting case here is a *number* problem, not
 * a rendering one: a media element reports `NaN` for the duration until its metadata arrives, `Infinity`
 * for a stream that has no end, and a fractional second on every frame. All three reach the screen.
 */

/** What is shown in place of a time that is not known yet. */
export const UNKNOWN_CLOCK = '–:––';

/**
 * A clock reading for a position in a file.
 *
 * Minutes and seconds, with hours only when there are any: `0:07`, `3:42`, `1:02:03`. A fixed `0:03:42`
 * would put two characters of nothing in front of every sound effect in the browser, and the column is
 * already narrow.
 */
export function formatClock(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return UNKNOWN_CLOCK;

  // Floored, not rounded. A file at 3.6s must not read `0:04` while its own last frame is still on
  // screen, and the same rule keeps the two ends of `0:07 / 0:07` agreeing at the end of playback.
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;

  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${minutes}:${pad(remainder)}`;
}

/**
 * A duration a transport can actually scrub.
 *
 * `NaN` before metadata loads and `Infinity` for a live stream both have to become "no duration", or a
 * slider is handed a max it cannot represent and collapses to its minimum — a scrubber pinned to the
 * left that does nothing when dragged.
 */
export function scrubbableDuration(duration: number | undefined): number | undefined {
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return undefined;
  return duration;
}

/** A seek position held inside the file, so a drag to either end cannot leave it. */
export function clampSeek(seconds: number, duration: number | undefined): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  const end = scrubbableDuration(duration);
  return end === undefined ? seconds : Math.min(seconds, end);
}
