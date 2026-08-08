import { describe, expect, it } from 'vitest';
import { FRAME_RATES, frameRate } from './frame-rate.js';
import { frameIndex } from './frame-time.js';
import {
  formatFrames,
  formatTimecode,
  framesToTimecode,
  parseTimecode,
  timecodeToFrames,
} from './timecode.js';

describe('non-drop timecode', () => {
  it('formats a whole-rate position', () => {
    expect(formatFrames(frameIndex(0), FRAME_RATES.WEB_30)).toBe('00:00:00:00');
    expect(formatFrames(frameIndex(29), FRAME_RATES.WEB_30)).toBe('00:00:00:29');
    expect(formatFrames(frameIndex(30), FRAME_RATES.WEB_30)).toBe('00:00:01:00');
    expect(formatFrames(frameIndex(1800), FRAME_RATES.WEB_30)).toBe('00:01:00:00');
    expect(formatFrames(frameIndex(108_000), FRAME_RATES.WEB_30)).toBe('01:00:00:00');
  });

  it('formats 25 and 24 fps', () => {
    expect(formatFrames(frameIndex(24), FRAME_RATES.PAL_25)).toBe('00:00:00:24');
    expect(formatFrames(frameIndex(25), FRAME_RATES.PAL_25)).toBe('00:00:01:00');
    expect(formatFrames(frameIndex(24), FRAME_RATES.FILM_24)).toBe('00:00:01:00');
  });

  it('marks negatives without corrupting the fields', () => {
    expect(formatFrames(frameIndex(-31), FRAME_RATES.WEB_30)).toBe('-00:00:01:01');
  });

  it('round-trips every frame of the first two minutes', () => {
    for (let f = 0; f < 3600; f += 1) {
      const position = frameIndex(f);
      const timecode = framesToTimecode(position, FRAME_RATES.PAL_25);
      expect(timecodeToFrames(timecode, FRAME_RATES.PAL_25)).toBe(position);
    }
  });
});

describe('drop-frame timecode at 29.97', () => {
  const rate = FRAME_RATES.NTSC_29_97;

  it('writes the frames field after a semicolon', () => {
    expect(formatFrames(frameIndex(0), rate)).toBe('00:00:00;00');
  });

  it('skips labels 00 and 01 at the top of a dropping minute', () => {
    // Minute 0 does not drop, so it holds a full 1800 real frames labelled
    // 00:00:00;00..00:00:59;29. Minute 1 therefore begins at real frame 1800, and
    // because it *is* a dropping minute its first label is ;02 rather than ;00.
    expect(formatFrames(frameIndex(1799), rate)).toBe('00:00:59;29');
    expect(formatFrames(frameIndex(1800), rate)).toBe('00:01:00;02');
    expect(formatFrames(frameIndex(1801), rate)).toBe('00:01:00;03');
  });

  it('does not drop on every tenth minute', () => {
    // 17982 frames is exactly ten minutes of 29.97 drop-frame.
    expect(formatFrames(frameIndex(17_982), rate)).toBe('00:10:00;00');
    expect(formatFrames(frameIndex(17_981), rate)).toBe('00:09:59;29');
  });

  it('keeps an hour on the hour', () => {
    // 107892 = 6 * 17982, the exact drop-frame hour.
    expect(formatFrames(frameIndex(107_892), rate)).toBe('01:00:00;00');
  });

  it('stays within a frame of wall-clock across an hour', () => {
    const timecode = framesToTimecode(frameIndex(107_892), rate);
    const labelSeconds = timecode.hours * 3600 + timecode.minutes * 60 + timecode.seconds;
    const realSeconds = (107_892 * 1001) / 30_000;
    expect(Math.abs(labelSeconds - realSeconds)).toBeLessThan(1);
  });

  it('round-trips every frame across a ten-minute block boundary', () => {
    for (let f = 0; f < 18_100; f += 1) {
      const position = frameIndex(f);
      const timecode = framesToTimecode(position, rate);
      expect(timecodeToFrames(timecode, rate)).toBe(position);
    }
  });

  it('round-trips across the hour boundary', () => {
    for (let f = 107_800; f < 108_000; f += 1) {
      const position = frameIndex(f);
      expect(timecodeToFrames(framesToTimecode(position, rate), rate)).toBe(position);
    }
  });
});

describe('drop-frame timecode at 59.94', () => {
  const rate = FRAME_RATES.NTSC_HD_59_94;

  it('drops four labels per dropping minute', () => {
    // Same shape as 29.97, scaled: minute 0 holds 3600 real frames.
    expect(formatFrames(frameIndex(3599), rate)).toBe('00:00:59;59');
    expect(formatFrames(frameIndex(3600), rate)).toBe('00:01:00;04');
  });

  it('round-trips a ten-minute block', () => {
    for (let f = 0; f < 36_100; f += 7) {
      const position = frameIndex(f);
      expect(timecodeToFrames(framesToTimecode(position, rate), rate)).toBe(position);
    }
  });
});

describe('23.976 is non-drop by convention', () => {
  it('uses a colon and counts to 24', () => {
    expect(formatFrames(frameIndex(24), FRAME_RATES.NTSC_FILM_23_976)).toBe('00:00:01:00');
  });
});

describe('parseTimecode', () => {
  it('parses non-drop input', () => {
    const result = parseTimecode('00:00:01:00', FRAME_RATES.WEB_30);
    expect(result).toEqual({ ok: true, value: 30 });
  });

  it('parses drop-frame input written with a semicolon', () => {
    const result = parseTimecode('00:01:00;02', FRAME_RATES.NTSC_29_97);
    expect(result).toEqual({ ok: true, value: 1800 });
  });

  it('accepts a colon at a drop-frame rate, since users type what is easy', () => {
    const result = parseTimecode('00:10:00:00', FRAME_RATES.NTSC_29_97);
    expect(result).toEqual({ ok: true, value: 17_982 });
  });

  it('rejects a frames field at or above the nominal rate', () => {
    const result = parseTimecode('00:00:00:30', FRAME_RATES.WEB_30);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('field-out-of-range');
  });

  it('rejects timecode labels that drop-frame skipped', () => {
    const result = parseTimecode('00:01:00;00', FRAME_RATES.NTSC_29_97);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('dropped-frame');
  });

  it('reports malformed input rather than guessing', () => {
    for (const text of ['', 'nope', '1:2', '00:99:00:00']) {
      const result = parseTimecode(text, FRAME_RATES.WEB_30);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('malformed');
    }
  });

  it('parses negatives', () => {
    const result = parseTimecode('-00:00:01:01', FRAME_RATES.WEB_30);
    expect(result).toEqual({ ok: true, value: -31 });
  });
});

describe('formatTimecode', () => {
  it('pads every field to two digits', () => {
    expect(
      formatTimecode({
        hours: 1,
        minutes: 2,
        seconds: 3,
        frames: 4,
        dropFrame: false,
        negative: false,
      }),
    ).toBe('01:02:03:04');
  });
});

describe('unusual rates', () => {
  it('treats a 1001-denominator rate below 30 as non-drop', () => {
    expect(formatFrames(frameIndex(0), frameRate(24000, 1001))).toBe('00:00:00:00');
  });
});
