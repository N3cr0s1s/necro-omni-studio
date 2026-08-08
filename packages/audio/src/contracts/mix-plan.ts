import type { AssetPath, ClipId, FrameIndex, FrameSpan, TrackId } from '@nos/core';

/**
 * Audio mix planning.
 *
 * Deliberately the same shape as the compositor's render plan: a pure description computed from the
 * document, with no Web Audio in sight. The reasons are the same too — the mix has to be identical
 * between preview and export or the rendered file will not match what the user auditioned, and
 * everything worth testing (which clips are live, what gain applies, how solo interacts with mute) is
 * decidable without an audio context.
 *
 * ## Why the plan is a span, not a frame
 *
 * The compositor plans one frame because it draws one frame. Audio cannot work that way: Web Audio
 * schedules buffers ahead of the clock, and per-frame scheduling at 30 fps produces audible seams at
 * every boundary. So a mix plan covers a *time range* and the scheduler asks for the next range before
 * the current one runs out.
 */

/** One clip contributing to the mix over a range. */
export interface MixSource {
  readonly clip: ClipId;
  readonly track: TrackId;
  readonly asset: AssetPath;
  /** When this source starts, in seconds on the timeline. */
  readonly startSeconds: number;
  /** How long it plays, in seconds of timeline. */
  readonly durationSeconds: number;
  /** Offset into the source file, in seconds. */
  readonly offsetSeconds: number;
  /**
   * Linear gain, clip and track combined.
   *
   * Combined here rather than modelled as two nodes: the plan describes *what should be heard*, and a
   * single value is both simpler to assert in a test and cheaper to apply. Per-node structure is the
   * engine's business.
   */
  readonly gain: number;
  /** −1 hard left to +1 hard right. */
  readonly pan: number;
  readonly speed: number;
  readonly preservePitch: boolean;
  /**
   * Gain automation within this source, if the clip's gain is keyframed.
   *
   * Points are timeline-relative seconds so the engine can schedule ramps directly. Empty when gain is
   * constant, which is the common case and lets the engine skip automation entirely.
   */
  readonly gainAutomation: readonly GainPoint[];
}

export interface GainPoint {
  /** Seconds on the timeline. */
  readonly atSeconds: number;
  readonly gain: number;
}

export interface MixPlan {
  /** Range this plan covers. */
  readonly span: FrameSpan;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly sources: readonly MixSource[];
}

/** Distinct assets the plan needs decoded, so the engine can prefetch once. */
export function mixAssets(plan: MixPlan): readonly AssetPath[] {
  return [...new Set(plan.sources.map((source) => source.asset))];
}

/**
 * Converts decibels to a linear gain multiplier.
 *
 * The UI works in dB because that is how people reason about level; the engine needs linear. Anything at
 * or below the floor maps to exact silence rather than a very small number, so a fader pulled all the
 * way down is truly silent instead of −∞ dB of noise.
 */
export const GAIN_FLOOR_DB = -60;

export function dbToGain(db: number): number {
  if (db <= GAIN_FLOOR_DB) return 0;
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  if (gain <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(gain);
}

/** `−6.2 dB` style readout, matching the mockups' transport bar. */
export function formatDb(gain: number): string {
  const db = gainToDb(gain);
  if (!Number.isFinite(db)) return '−∞ dB';
  const rounded = db.toFixed(1);
  // A minus sign rather than a hyphen: the mockups use typographic minus in numeric readouts.
  return `${db < 0 ? '−' : ''}${rounded.replace('-', '')} dB`;
}

/**
 * Equal-power stereo pan gains.
 *
 * Sine/cosine rather than linear: a linear pan law dips ~3 dB in the centre, so panning a source across
 * the field audibly loses level in the middle. Equal-power holds perceived loudness constant, which is
 * what an editor expects when they pan a voice off-centre.
 */
export function panGains(pan: number): { readonly left: number; readonly right: number } {
  const clamped = Math.min(1, Math.max(-1, Number.isFinite(pan) ? pan : 0));
  // Map [-1, 1] onto [0, π/2].
  const angle = ((clamped + 1) / 2) * (Math.PI / 2);
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

/** Peak levels for the transport meters, per channel. */
export interface MeterReading {
  /** Linear peak in `[0, 1]` per channel. */
  readonly peaks: readonly number[];
  /** True when any channel reached or exceeded unity since the last read. */
  readonly clipped: boolean;
}

/**
 * Peak meter with decay.
 *
 * A meter that follows the signal exactly is unreadable — peaks flash for one frame. Holding the peak
 * and decaying it gives the eye time to register, which is why every mixer does this.
 */
export interface PeakMeter {
  /** Feeds a block of samples per channel. */
  push(channels: readonly Float32Array[]): void;
  read(): MeterReading;
  reset(): void;
}

/** Decay in dB per second. Slow enough to read, fast enough to track a mix. */
export const METER_DECAY_DB_PER_SECOND = 20;

export function createPeakMeter(channelCount: number, now: () => number): PeakMeter {
  const peaks = new Array<number>(channelCount).fill(0);
  let clipped = false;
  let lastUpdate = now();

  return {
    push(channels: readonly Float32Array[]): void {
      const time = now();
      const elapsed = Math.max(0, (time - lastUpdate) / 1000);
      lastUpdate = time;

      const decay = dbToGain(-METER_DECAY_DB_PER_SECOND * elapsed);

      for (let channel = 0; channel < peaks.length; channel += 1) {
        const samples = channels[channel];
        let peak = 0;
        if (samples !== undefined) {
          for (const sample of samples) {
            const magnitude = Math.abs(sample);
            if (magnitude > peak) peak = magnitude;
          }
        }
        if (peak >= 1) clipped = true;
        // Rise instantly, fall gradually: a peak meter must never under-report a transient.
        const decayed = peaks[channel]! * decay;
        peaks[channel] = Math.max(peak, decayed);
      }
    },

    read(): MeterReading {
      return { peaks: [...peaks], clipped };
    },

    reset(): void {
      peaks.fill(0);
      clipped = false;
      lastUpdate = now();
    },
  };
}
