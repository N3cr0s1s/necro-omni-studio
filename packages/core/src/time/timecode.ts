import { type Result, err, ok } from '../lang/result.js';
import { type FrameRate, isDropFrameRate, nominalRate } from './frame-rate.js';
import { type FrameIndex, frameIndex } from './frame-time.js';

/**
 * SMPTE timecode conversion.
 *
 * The editor's readouts are frame indices at the project rate (`f 1042 / 3241`), but
 * users still think in `HH:MM:SS:FF`, so both are shown. Drop-frame is implemented
 * properly rather than approximated: at 29.97 the label sequence skips two frame
 * numbers at the start of every minute except every tenth, which keeps timecode within
 * a frame of wall-clock instead of drifting 3.6 s per hour.
 */
export interface Timecode {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly frames: number;
  /** Drop-frame timecode is conventionally written with `;` before the frames field. */
  readonly dropFrame: boolean;
  readonly negative: boolean;
}

export type TimecodeParseError =
  | { readonly kind: 'malformed'; readonly text: string }
  | { readonly kind: 'field-out-of-range'; readonly field: string; readonly value: number }
  | { readonly kind: 'dropped-frame'; readonly text: string };

/** Frame labels skipped per dropping minute, scaled by the rate family. */
function droppedPerMinute(rate: FrameRate): number {
  // 29.97 drops 2 labels a minute, 59.94 drops 4, 119.88 drops 8.
  return (nominalRate(rate) / 30) * 2;
}

export function framesToTimecode(position: FrameIndex, rate: FrameRate): Timecode {
  const negative = position < 0;
  const remaining = Math.abs(position);
  const nominal = nominalRate(rate);
  const dropFrame = isDropFrameRate(rate);

  if (dropFrame) {
    const dropped = droppedPerMinute(rate);
    const framesPerMinute = nominal * 60 - dropped;
    // Ten-minute blocks are exact: one non-dropping minute plus nine dropping ones.
    const blockFrames = nominal * 600 - dropped * 9;
    const blocks = Math.floor(remaining / blockFrames);
    let withinBlock = remaining % blockFrames;

    // The first minute of a block does not drop, so it is `dropped` frames longer.
    const firstMinuteFrames = nominal * 60;
    let minutesWithinBlock = 0;
    if (withinBlock >= firstMinuteFrames) {
      withinBlock -= firstMinuteFrames;
      minutesWithinBlock = 1 + Math.floor(withinBlock / framesPerMinute);
      withinBlock %= framesPerMinute;
      // Re-add the labels skipped at the head of this dropping minute.
      withinBlock += dropped;
    }

    const totalMinutes = blocks * 10 + minutesWithinBlock;
    return {
      hours: Math.floor(totalMinutes / 60),
      minutes: totalMinutes % 60,
      seconds: Math.floor(withinBlock / nominal),
      frames: withinBlock % nominal,
      dropFrame: true,
      negative,
    };
  }

  const frames = remaining % nominal;
  const totalSeconds = Math.floor(remaining / nominal);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor(totalSeconds / 60) % 60,
    seconds: totalSeconds % 60,
    frames,
    dropFrame: false,
    negative,
  };
}

export function timecodeToFrames(timecode: Timecode, rate: FrameRate): FrameIndex {
  const nominal = nominalRate(rate);
  const totalMinutes = timecode.hours * 60 + timecode.minutes;
  let total: number;

  if (timecode.dropFrame) {
    const dropped = droppedPerMinute(rate);
    const droppingMinutes = totalMinutes - Math.floor(totalMinutes / 10);
    total =
      totalMinutes * 60 * nominal + timecode.seconds * nominal + timecode.frames - droppingMinutes * dropped;
  } else {
    total = (totalMinutes * 60 + timecode.seconds) * nominal + timecode.frames;
  }

  return frameIndex(timecode.negative ? -total : total);
}

export function formatTimecode(timecode: Timecode): string {
  const separator = timecode.dropFrame ? ';' : ':';
  const sign = timecode.negative ? '-' : '';
  return (
    `${sign}${pad(timecode.hours)}:${pad(timecode.minutes)}:${pad(timecode.seconds)}` +
    `${separator}${pad(timecode.frames)}`
  );
}

/** Convenience for readouts: frame index straight to a display string. */
export function formatFrames(position: FrameIndex, rate: FrameRate): string {
  return formatTimecode(framesToTimecode(position, rate));
}

export function parseTimecode(text: string, rate: FrameRate): Result<FrameIndex, TimecodeParseError> {
  const trimmed = text.trim();
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;

  const match = /^(\d{1,3}):([0-5]?\d):([0-5]?\d)([:;])(\d{1,3})$/.exec(body);
  if (!match) return err({ kind: 'malformed', text });

  const [, rawHours, rawMinutes, rawSeconds, separator, rawFrames] = match;
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);
  const seconds = Number(rawSeconds);
  const frames = Number(rawFrames);
  const nominal = nominalRate(rate);

  if (frames >= nominal) {
    return err({ kind: 'field-out-of-range', field: 'frames', value: frames });
  }

  const dropFrame = separator === ';' || isDropFrameRate(rate);
  if (dropFrame) {
    const dropped = droppedPerMinute(rate);
    // Labels 00..dropped-1 do not exist at the head of a dropping minute.
    if (minutes % 10 !== 0 && seconds === 0 && frames < dropped) {
      return err({ kind: 'dropped-frame', text });
    }
  }

  return ok(timecodeToFrames({ hours, minutes, seconds, frames, dropFrame, negative }, rate));
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
