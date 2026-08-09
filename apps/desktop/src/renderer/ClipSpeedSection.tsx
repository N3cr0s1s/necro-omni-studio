import { type ReactNode, useState } from 'react';
import { GaugeIcon } from 'lucide-react';
import { type Clip, type TimelineDocument, clipSource, formatFrames, frameIndex } from '@nos/core';
import {
  MAX_SPEED,
  MIN_SPEED,
  canRetime,
  describeEditError,
  fittedDuration,
  setClipSpeed,
  speedOf,
} from '@nos/editing';
import { NumberField } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { Switch } from '@nos/ui/components/ui/switch';
import { cn } from '@nos/ui/lib/utils';

/**
 * Retiming a clip, per the `ClipSpeed` the document has carried since M4.
 *
 * The compositor scaled its source read, the mix plan scaled the offset and the rate, the filmstrip
 * drew half as much material for a half-speed clip, and the serializer round-tripped it — and nothing
 * anywhere could set the number, so every clip in every project sat at 1× forever.
 *
 * ## Why "keep the material" is a switch rather than two buttons
 *
 * Retiming means one of two things and they are not variants of each other. Change the factor alone
 * and the clip stays where it is, showing more or less material in the same slot — right when the cut
 * is already made to music. Keep the material instead and the clip's *length* changes, which is what
 * "slow this shot down" usually means. Neither is a safe default for the other's case, so it is stated
 * once and every change after it obeys, the way a mode should.
 *
 * ## Why presets sit beside the field
 *
 * Half and double are most of the real uses and are awkward to type accurately; the field is there for
 * everything else. Presets alone would make 1.15× impossible and a field alone would make the common
 * case a chore.
 */

/** The speeds worth one press. Half and double are most of what anyone reaches for. */
const PRESETS = [0.25, 0.5, 1, 2, 4] as const;

export interface ClipSpeedSectionProps {
  readonly document: TimelineDocument;
  readonly clip: Clip;
  readonly onChange: (label: string, next: TimelineDocument) => void;
  /** Surfaces a refusal: growing a clip into the next one legitimately fails. */
  readonly onReject?: ((reason: string) => void) | undefined;
}

export function ClipSpeedSection({ document, clip, onChange, onReject }: ClipSpeedSectionProps): ReactNode {
  /*
   * Whether a change keeps the material or the length. Local, and deliberately not stored in the
   * document: it is how the *next* edit should behave, not a property of the clip. Persisting it would
   * make a project file remember a preference and apply it to a different clip a week later.
   */
  const [fitDuration, setFitDuration] = useState(true);

  // Titles and stills have no source rate to scale, so there is nothing here for them to say.
  if (!canRetime(clip)) return undefined;

  const speed = speedOf(clip);
  const source = clipSource(clip);

  const apply = (factor: number, preservePitch = speed.preservePitch): void => {
    const result = setClipSpeed(document, clip.id, { factor, preservePitch }, { fitDuration });
    if (result.ok) onChange('set clip speed', result.value);
    else onReject?.(describeEditError(result.error));
  };

  const wouldBecome = fittedDuration(clip, speed.factor);

  return (
    <section aria-label="Speed" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Speed</span>
        {/* What the clip is actually reading. A retimed clip whose length did not change is showing
            different material in the same slot, and that is invisible without saying so. */}
        <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
          {formatFrames(frameIndex(clip.span.duration as number), document.frameRate)}
          {source !== undefined && speed.factor !== 1
            ? ` · ${Math.round((clip.span.duration as number) * speed.factor)}f of source`
            : ''}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <GaugeIcon className="text-muted-foreground/60 size-3.5 shrink-0" />
        <span className="text-muted-foreground w-14 text-xs">factor</span>
        <NumberField
          aria-label="Speed factor"
          value={speed.factor}
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={0.05}
          onCommit={(next) => apply(next)}
          className="w-20"
        />
        <span className="text-muted-foreground text-xs">×</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <Button
            key={preset}
            variant="outline"
            size="sm"
            aria-pressed={speed.factor === preset}
            onClick={() => apply(preset)}
            className={cn('font-mono', speed.factor === preset && 'ring-ring ring-2')}
          >
            {preset}×
          </Button>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs">
        <Switch
          checked={fitDuration}
          onCheckedChange={setFitDuration}
          aria-label="Keep the material and change the length"
        />
        <span className="text-muted-foreground">
          keep the material
          {/* What the switch will actually do to this clip, in frames. "Changes the length" is true
              and says nothing about how much. */}
          {fitDuration && wouldBecome !== (clip.span.duration as number)
            ? ` · this clip would become ${wouldBecome}f`
            : ''}
        </span>
      </label>

      <label className="flex items-center gap-2 text-xs">
        <Switch
          checked={speed.preservePitch}
          onCheckedChange={(next) => apply(speed.factor, next)}
          aria-label="Preserve pitch"
        />
        <span className="text-muted-foreground">preserve pitch</span>
      </label>
    </section>
  );
}
