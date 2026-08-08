import type { ReactNode } from 'react';
import { token } from '../tokens/tokens.js';

/**
 * The output level meter.
 *
 * The spec's §6.2 asks for an audio mix, and a mix without a meter is a mix you cannot check: the
 * engine has computed peaks with proper decay since M3 and nothing displayed them, so the only way
 * to know whether a project clipped was to export it and listen.
 *
 * Deliberately presentational and unit-free at its edges — it takes linear peaks, because that is
 * what the engine measures, and does the dB mapping here where the scale is drawn.
 */

/** Bottom of the scale. Below this a signal is inaudible in any practical monitoring situation. */
export const METER_FLOOR_DB = -48;

/**
 * Where the amber zone starts.
 *
 * −6 dBFS, the conventional headroom mark: a mix peaking above it has little room left for the
 * summing that mastering will add, which is worth showing before it becomes a red clip indicator.
 */
export const METER_WARN_DB = -6;

export interface LevelMeterProps {
  /** Linear peak per channel in `[0, 1]`. Absent means nothing is playing. */
  readonly peaks?: readonly number[];
  /** Latched: a clip that happened a second ago still matters. */
  readonly clipped?: boolean;
  readonly widthPx?: number;
  /** Resets the latched clip indicator. */
  readonly onClearClip?: () => void;
}

/**
 * Position of a linear peak on the meter's scale, in `[0, 1]`.
 *
 * Logarithmic, because the meter is read against dB marks and a linear bar spends nine tenths of its
 * travel in the top 20 dB — the region where the difference between −40 and −20 dBFS, which is the
 * difference between "present" and "inaudible", would be invisible.
 */
export function meterPosition(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  if (db <= METER_FLOOR_DB) return 0;
  return Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB);
}

/** Colour of the bar at a given peak, matching the scale's zones. */
export function meterTone(peak: number): string {
  const db = peak > 0 ? 20 * Math.log10(peak) : METER_FLOOR_DB;
  if (db >= 0) return token.danger;
  if (db >= METER_WARN_DB) return token.warn;
  return token.ok;
}

export function LevelMeter({
  peaks,
  clipped = false,
  widthPx = 64,
  onClearClip,
}: LevelMeterProps): ReactNode {
  // Two rows always, even with nothing playing: a meter that appeared and disappeared would move the
  // transport's controls under the pointer every time playback started.
  const channels = peaks === undefined || peaks.length === 0 ? [0, 0] : peaks;

  return (
    <div
      role="meter"
      aria-label="Output level"
      aria-valuemin={METER_FLOOR_DB}
      aria-valuemax={0}
      aria-valuenow={Math.round(loudestDb(channels))}
      aria-valuetext={describeLevel(channels, clipped)}
      style={{ display: 'flex', alignItems: 'center', gap: token.space2 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: widthPx }}>
        {channels.map((peak, index) => (
          <div
            key={index}
            data-meter-channel={index}
            style={{
              height: 4,
              borderRadius: 1,
              background: token.surface2,
              overflow: 'hidden',
            }}
          >
            <div
              data-meter-fill={index}
              style={{
                width: `${meterPosition(peak) * 100}%`,
                height: '100%',
                background: meterTone(peak),
                // No transition: the bar must rise instantly. The decay that makes a peak readable is
                // the engine's, applied to the value — animating on top of it would report a level
                // that was never measured.
                transition: 'none',
              }}
            />
          </div>
        ))}
      </div>

      {/* Latched and clickable. A clip that happened while the editor looked away is exactly the one
          worth knowing about, so it stays lit until acknowledged. */}
      <button
        type="button"
        aria-label={clipped ? 'Output clipped — click to reset' : 'Output has not clipped'}
        title={clipped ? 'Output clipped. Click to reset.' : 'No clipping'}
        onClick={onClearClip}
        disabled={!clipped}
        style={{
          width: 8,
          height: 8,
          padding: 0,
          borderRadius: 2,
          border: `1px solid ${clipped ? token.danger : token.borderControl}`,
          background: clipped ? token.danger : 'transparent',
          cursor: clipped && onClearClip !== undefined ? 'pointer' : 'default',
        }}
      />
    </div>
  );
}

function loudestDb(peaks: readonly number[]): number {
  const loudest = peaks.reduce((most, peak) => Math.max(most, peak), 0);
  return loudest > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(loudest)) : METER_FLOOR_DB;
}

/**
 * The reading as a screen reader hears it.
 *
 * A number, not a picture of one: the bar's colour carries the warning visually, and an assistive
 * reading that said only "meter" would leave the clipping state — the one thing this control exists
 * to report — unavailable.
 */
export function describeLevel(peaks: readonly number[], clipped: boolean): string {
  const db = loudestDb(peaks);
  const level = db <= METER_FLOOR_DB ? 'silent' : `${db.toFixed(1)} dBFS`;
  return clipped ? `${level}, clipped` : level;
}
