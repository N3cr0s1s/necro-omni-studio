import { describe, expect, it } from 'vitest';
import { FRAME_RATES } from './frame-rate.js';
import { frameIndex } from './frame-time.js';
import { describeSeekEntryError, parseSeekEntry, seekEntryText } from './timecode-entry.js';

const at30 = { rate: FRAME_RATES.WEB_30, current: frameIndex(0) };
const value = (result: ReturnType<typeof parseSeekEntry>) => (result.ok ? result.value : undefined);
const error = (result: ReturnType<typeof parseSeekEntry>) => (result.ok ? undefined : result.error);

describe('full timecode', () => {
  it('is accepted as written', () => {
    expect(value(parseSeekEntry('00:00:12:15', at30))).toBe(375);
  });

  it('does not insist on padding', () => {
    expect(value(parseSeekEntry('0:0:12:15', at30))).toBe(375);
  });

  it('accepts the separators a numeric keypad makes easy', () => {
    // A keypad has a full stop and no colon, and a field that refused it would be slower to type
    // than dragging the playhead — which is the only reason the field exists.
    expect(value(parseSeekEntry('0.0.12.15', at30))).toBe(375);
    expect(value(parseSeekEntry('0 0 12 15', at30))).toBe(375);
  });
});

describe('partial entry', () => {
  it('fills digits from the right, as every editor does', () => {
    // The convention that lets a timecode field be typed without looking at it.
    expect(value(parseSeekEntry('15', at30))).toBe(15);
    expect(value(parseSeekEntry('1215', at30))).toBe(375);
    expect(value(parseSeekEntry('10000', at30))).toBe(30 * 60);
  });

  it('refuses more digits than a timecode has', () => {
    // A seek to the wrong place is worse than a rejected entry.
    expect(error(parseSeekEntry('123456789', at30))?.kind).toBe('malformed');
  });

  it('refuses a frame field the rate cannot have', () => {
    expect(error(parseSeekEntry('45', at30))?.kind).toBe('malformed');
  });

  it('refuses a seconds field above 59', () => {
    expect(error(parseSeekEntry('7500', at30))?.kind).toBe('malformed');
  });
});

describe('frames', () => {
  it('is written either way round', () => {
    expect(value(parseSeekEntry('1042f', at30))).toBe(1042);
    expect(value(parseSeekEntry('f1042', at30))).toBe(1042);
  });

  it('is not mistaken for a partial timecode', () => {
    // `120f` is 120 frames — four seconds. Without the `f` the same digits fill from the right and
    // mean one second and twenty frames, which is 50. Both readings are right for what was typed.
    expect(value(parseSeekEntry('120f', at30))).toBe(120);
    expect(value(parseSeekEntry('120', at30))).toBe(50);
  });
});

describe('relative entry', () => {
  it('moves from where the playhead is, in frames', () => {
    // A bare number after a sign is frames, which is what every editor does and the only reading
    // that makes `+30` useful: as a partial timecode it would be thirty frames at a rate with none.
    expect(value(parseSeekEntry('+30', { ...at30, current: frameIndex(100) }))).toBe(130);
    expect(value(parseSeekEntry('-30', { ...at30, current: frameIndex(100) }))).toBe(70);
  });

  it('takes a timecode as its magnitude, so there is one syntax rather than two', () => {
    expect(value(parseSeekEntry('+1:00', { ...at30, current: frameIndex(0) }))).toBe(30);
    expect(value(parseSeekEntry('+00:00:01:00', { ...at30, current: frameIndex(0) }))).toBe(30);
  });

  it('fills a short separated entry from the right, like the digit form', () => {
    // `12:15` is twelve seconds and fifteen frames. Demanding four fields would make the field
    // slower to use than the arrow keys.
    expect(value(parseSeekEntry('12:15', at30))).toBe(375);
    expect(value(parseSeekEntry('1:00:00', at30))).toBe(30 * 60);
  });

  it('takes frames', () => {
    expect(value(parseSeekEntry('+250f', { ...at30, current: frameIndex(0) }))).toBe(250);
  });

  it('tolerates a space after the sign', () => {
    expect(value(parseSeekEntry('+ 30', { ...at30, current: frameIndex(100) }))).toBe(130);
  });

  it('stops at zero rather than going negative', () => {
    expect(value(parseSeekEntry('-500', { ...at30, current: frameIndex(10) }))).toBe(0);
  });
});

describe('clamping', () => {
  it('lands on the last frame when the entry is past the end', () => {
    // Typing past the end is how a user asks to go *to* the end; an error there would be pedantry
    // about an unambiguous intention.
    expect(value(parseSeekEntry('10:00:00:00', { ...at30, duration: 300 }))).toBe(299);
  });

  it('leaves an entry alone when there is no known duration', () => {
    // An empty sequence has no last frame, and clamping to zero would turn every entry into a seek
    // to the start.
    expect(value(parseSeekEntry('00:00:10:00', at30))).toBe(300);
  });
});

describe('drop-frame', () => {
  const at2997 = { rate: FRAME_RATES.NTSC_29_97, current: frameIndex(0) };

  it('reads a drop-frame timecode', () => {
    // Drop-frame skips *labels*, not frames: the first frame of minute one is still frame 1800, and
    // it carries the label `;02` because `;00` and `;01` do not exist.
    expect(value(parseSeekEntry('00:01:00:02', at2997))).toBe(1800);
  });

  it('accepts the semicolon separator it is conventionally written with', () => {
    expect(value(parseSeekEntry('00:01:00;02', at2997))).toBe(1800);
  });

  it('explains a label that drop-frame skips, rather than looking broken', () => {
    // The one error that reads as a bug until it is explained: no frame has that timecode.
    const failed = parseSeekEntry('00:01:00:00', at2997);
    expect(failed.ok).toBe(false);
    const message = !failed.ok ? describeSeekEntryError(failed.error, FRAME_RATES.NTSC_29_97) : '';
    expect(message).toContain('drop-frame skips it');
  });

  it('round-trips what the readout shows', () => {
    // The field's own displayed text must be accepted back, or a user who edits one digit of it is
    // told their timecode is malformed.
    for (const frame of [0, 1800, 17_982, 107_892]) {
      const shown = seekEntryText(frameIndex(frame), FRAME_RATES.NTSC_29_97);
      expect(value(parseSeekEntry(shown, at2997))).toBe(frame);
    }
  });
});

describe('what a refusal says', () => {
  it('names the accepted forms rather than only reporting failure', () => {
    const failed = parseSeekEntry('nonsense', at30);
    const message = !failed.ok ? describeSeekEntryError(failed.error, FRAME_RATES.WEB_30) : '';
    expect(message).toContain('250f');
    expect(message).toContain('+30');
  });

  it('says what an empty field wants', () => {
    const failed = parseSeekEntry('   ', at30);
    expect(!failed.ok && failed.error.kind).toBe('empty');
    const message = !failed.ok ? describeSeekEntryError(failed.error, FRAME_RATES.WEB_30) : '';
    expect(message).toContain('relative move');
  });
});
