import { describe, expect, it } from 'vitest';
import { METER_DECAY_DB_PER_SECOND, createPeakMeter, dbToGain } from './mix-plan.js';

/** A clock the test advances explicitly, so decay is deterministic rather than wall-clock dependent. */
function testClock() {
  let time = 0;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

const block = (...samples: number[]) => new Float32Array(samples);

describe('createPeakMeter', () => {
  it('starts silent', () => {
    const clock = testClock();
    const meter = createPeakMeter(2, clock.now);
    expect(meter.read()).toEqual({ peaks: [0, 0], clipped: false });
  });

  it('rises instantly to a peak, so a transient is never under-reported', () => {
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(0.1, 0.7, 0.2)]);
    expect(meter.read().peaks[0]).toBeCloseTo(0.7, 6);
  });

  it('takes the magnitude, so a negative peak registers', () => {
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(-0.8, 0.1)]);
    expect(meter.read().peaks[0]).toBeCloseTo(0.8, 6);
  });

  it('meters channels independently', () => {
    const clock = testClock();
    const meter = createPeakMeter(2, clock.now);
    meter.push([block(0.9), block(0.2)]);
    const { peaks } = meter.read();
    expect(peaks[0]).toBeCloseTo(0.9, 6);
    expect(peaks[1]).toBeCloseTo(0.2, 6);
  });

  it('decays at the documented rate, so a peak stays readable', () => {
    // A meter that follows the signal exactly flashes for one frame and is unreadable.
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(1)]);

    clock.advance(500);
    meter.push([block(0)]);

    // Half a second at 20 dB/s is 10 dB down.
    expect(meter.read().peaks[0]).toBeCloseTo(dbToGain(-METER_DECAY_DB_PER_SECOND * 0.5), 3);
  });

  it('holds a peak when no time has passed', () => {
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(0.5)]);
    meter.push([block(0)]);
    expect(meter.read().peaks[0]).toBeCloseTo(0.5, 6);
  });

  it('replaces a decaying peak with a louder new one', () => {
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(0.5)]);
    clock.advance(200);
    meter.push([block(0.9)]);
    expect(meter.read().peaks[0]).toBeCloseTo(0.9, 6);
  });

  it('latches a clip indicator until reset', () => {
    // Clipping that clears itself is worse than none: the user will not be looking at that instant.
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(1.2)]);
    expect(meter.read().clipped).toBe(true);

    clock.advance(2000);
    meter.push([block(0)]);
    expect(meter.read().clipped).toBe(true);

    meter.reset();
    expect(meter.read().clipped).toBe(false);
  });

  it('treats exactly unity as clipping', () => {
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(1)]);
    expect(meter.read().clipped).toBe(true);
  });

  it('does not flag a hot but sub-unity signal', () => {
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(0.999)]);
    expect(meter.read().clipped).toBe(false);
  });

  it('tolerates fewer supplied channels than it meters', () => {
    // A mono source feeding a stereo meter must not throw; the missing channel simply decays.
    const clock = testClock();
    const meter = createPeakMeter(2, clock.now);
    expect(() => meter.push([block(0.5)])).not.toThrow();
    expect(meter.read().peaks[1]).toBe(0);
  });

  it('returns a copy, so a caller cannot mutate its internal state', () => {
    const clock = testClock();
    const meter = createPeakMeter(1, clock.now);
    meter.push([block(0.5)]);
    const reading = meter.read();
    (reading.peaks as number[])[0] = 99;
    expect(meter.read().peaks[0]).toBeCloseTo(0.5, 6);
  });

  it('clears peaks on reset', () => {
    const clock = testClock();
    const meter = createPeakMeter(2, clock.now);
    meter.push([block(0.8), block(0.8)]);
    meter.reset();
    expect(meter.read().peaks).toEqual([0, 0]);
  });
});
