import type { ReactNode } from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { Button } from '@nos/ui/components/ui/button';
import { Progress } from '@nos/ui/components/ui/progress';
import { cn } from '@nos/ui/lib/utils';

/**
 * The output level meter.
 *
 * The spec's §6.2 asks for an audio mix, and a mix without a meter is a mix you cannot check: the
 * engine has computed peaks with proper decay since M3 and nothing displayed them, so the only way
 * to know whether a project clipped was to export it and listen.
 *
 * Deliberately presentational and unit-free at its edges — it takes linear peaks, because that is
 * what the engine measures, and does the dB mapping here where the scale is drawn.
 *
 * ## Why a progress bar
 *
 * There is no meter in the registry, and a filled track is what a meter *is*. So each channel is a
 * `Progress`, and the outer element carries `role="meter"` — the semantics the reading actually has —
 * rather than leaving a screen reader to interpret two progress bars as an audio level.
 */

/** Bottom of the scale. Below this a signal is inaudible in any practical monitoring situation. */
export const METER_FLOOR_DB = -48;

/**
 * Where the warning zone starts.
 *
 * −6 dBFS, the conventional headroom mark: a mix peaking above it has little room left for the
 * summing that mastering will add, which is worth showing before it becomes a clip indicator.
 */
export const METER_WARN_DB = -6;

export interface LevelMeterProps {
  /** Linear peak per channel in `[0, 1]`. Absent means nothing is playing. */
  readonly peaks?: readonly number[];
  /** Latched: a clip that happened a second ago still matters. */
  readonly clipped?: boolean;
  /** Resets the latched clip indicator. */
  readonly onClearClip?: () => void;
  readonly className?: string | undefined;
}

/**
 * Position of a linear peak on the meter's scale, as a percentage.
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

/**
 * How the bar is painted at a given peak.
 *
 * Three zones, expressed in the only colour vocabulary the theme has: `primary` while there is
 * headroom, `destructive` at or above full scale, and a softened `destructive` in between. The
 * softened step is an opacity on a role rather than a fourth colour, so it stays correct in dark mode
 * and under any theme — which a hand-picked amber would not.
 *
 * Returned as a Tailwind selector on the indicator slot because `Progress` composes its own track and
 * indicator; this is how a caller reaches inside one without forking the component.
 */
export function meterTone(peak: number): string {
  const db = peak > 0 ? 20 * Math.log10(peak) : METER_FLOOR_DB;
  if (db >= 0) return '[&_[data-slot=progress-indicator]]:bg-destructive';
  if (db >= METER_WARN_DB) return '[&_[data-slot=progress-indicator]]:bg-destructive/60';
  return '[&_[data-slot=progress-indicator]]:bg-primary';
}

export function LevelMeter({ peaks, clipped = false, onClearClip, className }: LevelMeterProps): ReactNode {
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
      className={cn('flex items-center gap-2', className)}
    >
      <div className="flex w-16 flex-col gap-0.5">
        {channels.map((peak, index) => (
          <Progress
            key={index}
            data-meter-channel={index}
            // The bars are the picture; the reading is on the `meter` above them. Left in the
            // accessibility tree they would announce "98 percent" twice, in a unit the meter does not
            // use, and bury the one thing that matters — whether it clipped.
            aria-hidden="true"
            value={meterPosition(peak) * 100}
            className={cn(
              'block',
              // No transition: the bar must rise instantly. The decay that makes a peak readable is
              // the engine's, applied to the value — animating on top of it would draw a level that
              // was never measured.
              '[&_[data-slot=progress-indicator]]:transition-none',
              meterTone(peak),
            )}
          />
        ))}
      </div>

      {/* Latched and clickable. A clip that happened while the editor looked away is exactly the one
          worth knowing about, so it stays lit until acknowledged. */}
      <Button
        variant={clipped ? 'destructive' : 'ghost'}
        size="icon-xs"
        aria-label={clipped ? 'Output clipped — click to reset' : 'Output has not clipped'}
        title={clipped ? 'Output clipped. Click to reset.' : 'No clipping'}
        onClick={onClearClip}
        disabled={!clipped}
      >
        <TriangleAlertIcon />
      </Button>
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
