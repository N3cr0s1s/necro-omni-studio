import { type Result, err, ok } from '../lang/result.js';
import { type FrameRate, nominalRate } from './frame-rate.js';
import { type FrameIndex, frameIndex } from './frame-time.js';
import { type TimecodeParseError, formatFrames, parseTimecode } from './timecode.js';

/**
 * What a user typed into a timecode field, as a frame to seek to.
 *
 * `parseTimecode` handles SMPTE, exactly and including drop-frame — and nobody types SMPTE. Every
 * editor in existence accepts the shorthands below instead, and a field that demanded `00:00:12:15`
 * would be slower than dragging the playhead, which is the only reason to have the field at all.
 *
 * The forms accepted, in the order they are recognised:
 *
 * - **Relative** — `+30`, `-1:00`, `+250f`. What you want when the shot is a few frames too long. A
 *   bare number after a sign is a count of **frames**, which is what every editor does and the only
 *   reading that makes `+30` useful — as a partial timecode it would mean thirty frames at a rate
 *   that has none, and be rejected.
 * - **Frames** — `1042f`, `f1042`. The other unit the readouts already show.
 * - **Partial timecode** — `15` is fifteen frames, `1215` is twelve seconds and fifteen frames,
 *   `10000` is one minute. Digits fill from the right, which is the convention every NLE shares and
 *   the reason it can be typed without looking.
 * - **Full timecode** — `00:00:12:15`, `1:2:3:4`, and the `;` drop-frame separator.
 *
 * Parsing is kept apart from the field that uses it because the interesting cases are all textual —
 * an out-of-range frame number, a dropped frame label, a relative move past zero — and none of them
 * need a rendered input to be checked.
 */

export type SeekEntryError =
  | { readonly kind: 'empty' }
  | { readonly kind: 'malformed'; readonly text: string }
  | { readonly kind: 'timecode'; readonly cause: TimecodeParseError };

export interface SeekEntryContext {
  readonly rate: FrameRate;
  /** Where the playhead is, which a relative entry moves from. */
  readonly current: FrameIndex;
  /**
   * One past the last seekable frame, when the caller wants clamping.
   *
   * Omitted rather than defaulted: an empty sequence has no last frame, and clamping to zero there
   * would silently turn every entry into a seek to the start.
   */
  readonly duration?: number;
}

/**
 * The frame a typed entry means.
 *
 * Clamped rather than refused when it lands outside the sequence: typing past the end is how a user
 * asks to go *to* the end, and an error there would be pedantry about an unambiguous intention.
 * Negative results clamp to zero for the same reason.
 */
export function parseSeekEntry(text: string, context: SeekEntryContext): Result<FrameIndex, SeekEntryError> {
  const trimmed = text.trim();
  if (trimmed === '') return err({ kind: 'empty' });

  const relative = /^([+-])\s*(.+)$/u.exec(trimmed);
  if (relative !== undefined && relative !== null) {
    const [, sign, rest] = relative;
    // Frames when it is a bare number, and an absolute entry otherwise — so `+30` is thirty frames
    // and `+1:00` is a second, without needing two syntaxes for the same idea.
    const body = (rest ?? '').trim();
    const magnitude = /^\d+$/u.test(body) ? ok(Number(body)) : parseAbsolute(body, context.rate);
    if (!magnitude.ok) return magnitude;
    const delta = sign === '-' ? -magnitude.value : magnitude.value;
    return ok(clamp(context.current + delta, context.duration));
  }

  const absolute = parseAbsolute(trimmed, context.rate);
  if (!absolute.ok) return absolute;
  return ok(clamp(absolute.value, context.duration));
}

/** An entry with no sign, as a count of frames from zero. */
function parseAbsolute(text: string, rate: FrameRate): Result<number, SeekEntryError> {
  const trimmed = text.trim();
  if (trimmed === '') return err({ kind: 'empty' });

  // Frames, written either way round. Checked before the digit form so `120f` is not read as a
  // partial timecode that happens to end in a letter.
  const frames = /^(?:f\s*(\d+)|(\d+)\s*f)$/iu.exec(trimmed);
  if (frames !== null) {
    return ok(Number(frames[1] ?? frames[2]));
  }

  if (/^\d+$/u.test(trimmed)) return expandDigits(trimmed, rate);

  const parsed = parseTimecode(expandFields(normalizeSeparators(trimmed)), rate);
  if (!parsed.ok) return err({ kind: 'timecode', cause: parsed.error });
  return ok(parsed.value);
}

/**
 * Fills a short separated entry from the right, so `12:15` is twelve seconds and fifteen frames.
 *
 * The same rule as a bare digit run, and needed for the same reason: `+1:00` is how a user asks to
 * move a second, and demanding `+00:00:01:00` for it would make the field slower than the arrow keys.
 * A drop-frame `;` is preserved wherever it was written, since it belongs to the frames field.
 */
function expandFields(text: string): string {
  const dropFrame = text.includes(';');
  const fields = text.replace(';', ':').split(':');
  if (fields.length >= 4) return text;

  const filled = ['0', '0', '0', '0'];
  for (let index = 0; index < fields.length; index += 1) {
    filled[filled.length - fields.length + index] = fields[index] ?? '0';
  }
  const [hours, minutes, seconds, frames] = filled;
  return `${hours}:${minutes}:${seconds}${dropFrame ? ';' : ':'}${frames}`;
}

/**
 * Fills a bare run of digits from the right: `SS:FF`, then `MM:SS:FF`, then `HH:MM:SS:FF`.
 *
 * The convention every editor shares, and the reason a timecode field can be typed without looking
 * at it. Longer than eight digits is not a timecode anyone meant, so it is refused rather than
 * silently truncated — a seek to the wrong place is worse than a rejected entry.
 */
function expandDigits(digits: string, rate: FrameRate): Result<number, SeekEntryError> {
  if (digits.length > 8) return err({ kind: 'malformed', text: digits });

  const padded = digits.padStart(8, '0');
  const hours = Number(padded.slice(0, 2));
  const minutes = Number(padded.slice(2, 4));
  const seconds = Number(padded.slice(4, 6));
  const frames = Number(padded.slice(6, 8));
  const nominal = nominalRate(rate);

  // Checked here rather than left to `parseTimecode`, whose message would name a field the user
  // never typed — they typed `1275`, not a seconds field.
  if (minutes > 59 || seconds > 59 || frames >= nominal) {
    return err({ kind: 'malformed', text: digits });
  }

  const parsed = parseTimecode(`${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`, rate);
  if (!parsed.ok) return err({ kind: 'timecode', cause: parsed.error });
  return ok(parsed.value);
}

/** Accepts `.` and a bare space as separators, which is what a numeric keypad makes easy to type. */
function normalizeSeparators(text: string): string {
  return text.replace(/[.\s]+/gu, ':');
}

function clamp(frame: number, duration: number | undefined): FrameIndex {
  const floored = Math.max(0, Math.round(frame));
  if (duration === undefined || duration <= 0) return frameIndex(floored);
  return frameIndex(Math.min(floored, duration - 1));
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Why an entry was refused, in words a user can act on.
 *
 * Every branch names what to do instead. "Invalid timecode" tells someone that something is wrong
 * and nothing about which of the four accepted forms they nearly typed.
 */
export function describeSeekEntryError(error: SeekEntryError, rate: FrameRate): string {
  switch (error.kind) {
    case 'empty':
      return 'type a timecode, a frame number, or a relative move like +30';
    case 'malformed':
      return `${error.text} is not a timecode — try 00:00:12:15, 1215, 250f or +30`;
    case 'timecode':
      return describeTimecodeCause(error.cause, rate);
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled seek entry error ${JSON.stringify(unreachable)}`);
    }
  }
}

function describeTimecodeCause(cause: TimecodeParseError, rate: FrameRate): string {
  switch (cause.kind) {
    case 'field-out-of-range':
      return `${cause.value} is too large for ${cause.field} at ${nominalRate(rate)} fps`;
    case 'dropped-frame':
      // The one error that looks like a bug until it is explained: those labels do not exist.
      return `${cause.text} is a dropped label — drop-frame skips it, so no frame has that timecode`;
    case 'malformed':
      return `${cause.text} is not a timecode — try 00:00:12:15, 1215, 250f or +30`;
    default: {
      const unreachable: never = cause;
      throw new Error(`Unhandled timecode error ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The text a field shows when it is not being edited. */
export function seekEntryText(frame: FrameIndex, rate: FrameRate): string {
  return formatFrames(frame, rate);
}
