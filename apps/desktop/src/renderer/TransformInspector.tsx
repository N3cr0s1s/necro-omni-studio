import { type ReactNode } from 'react';
import { DiamondIcon, FrameIcon, RotateCcwIcon } from 'lucide-react';
import {
  type AnimatableNumber,
  type Clip,
  type TimelineDocument,
  animatedNumber,
  evaluateAt,
  frameIndex,
  isAnimated,
  keyframeId,
  staticNumber,
} from '@nos/core';
import {
  type TransformChannel,
  type TransformChannelSpec,
  TRANSFORM_SPECS,
  clipTransform,
  isTransformed,
  resetTransform,
  setTransformChannel,
} from '@nos/editing';
import { NumberField } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { Label } from '@nos/ui/components/ui/label';
import { Slider } from '@nos/ui/components/ui/slider';
import { Toggle } from '@nos/ui/components/ui/toggle';
import { cn } from '@nos/ui/lib/utils';

/**
 * Where a clip sits, how big it is, how it is turned, and how much of it shows.
 *
 * The compositor has evaluated all five channels per frame since M4 and the shader honours every one
 * — and nothing in the application could write any of them. A clip was pinned at the centre, unscaled
 * and fully opaque forever. That also left the spec's §6.5 "pozíció" for a title with no control, and
 * left opacity, the channel every fade needs, reachable only by a text preset generating keyframes on
 * the user's behalf.
 *
 * Each channel is a slider, a number and an animate toggle, matching the effect parameters and the
 * audio mix exactly — three panels doing the same job differently is three things to learn. The value
 * control is disabled once a channel is animated, because a keyframed value belongs to its lane; that
 * is only tolerable now that a lane can be typed into, which it could not be before.
 */

export interface TransformInspectorProps {
  readonly document: TimelineDocument;
  readonly clip: Clip;
  /** The frame the values are read at, so an animated channel reads as what is on screen now. */
  readonly playhead: number;
  readonly onChange: (label: string, next: TimelineDocument) => void;
  readonly onReject?: (reason: string) => void;
}

export function TransformInspector({
  document,
  clip,
  playhead,
  onChange,
  onReject,
}: TransformInspectorProps): ReactNode {
  const transform = clipTransform(clip);
  // Audio has no framing. Rendering an empty section for it would be a promise about a control that
  // cannot exist, which is the same mistake as a permanently disabled one.
  if (transform === undefined) return null;

  // Clip-relative, because keyframes are: a clip moved down the timeline must keep its animation.
  const local = frameIndex(Math.max(0, playhead - clip.span.start));

  const write = (label: string, channel: TransformChannel, value: AnimatableNumber): void => {
    const result = setTransformChannel(document, clip.id, channel, value);
    if (result.ok) onChange(label, result.value);
    else onReject?.(`the clip could not be framed: ${String(result.error.kind).replace(/-/gu, ' ')}`);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <FrameIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Framing</span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={!isTransformed(clip)}
          onClick={() => {
            const result = resetTransform(document, clip.id);
            if (result.ok) onChange('reset framing', result.value);
            else
              onReject?.(`the framing could not be reset: ${String(result.error.kind).replace(/-/gu, ' ')}`);
          }}
          title="Return every channel to neutral, discarding any animation on them"
        >
          <RotateCcwIcon />
          Reset
        </Button>
      </div>

      {TRANSFORM_SPECS.map((spec) => (
        <Channel key={spec.channel} spec={spec} value={transform[spec.channel]} at={local} onWrite={write} />
      ))}
    </div>
  );
}

function Channel({
  spec,
  value,
  at,
  onWrite,
}: {
  readonly spec: TransformChannelSpec;
  readonly value: AnimatableNumber;
  readonly at: ReturnType<typeof frameIndex>;
  readonly onWrite: (label: string, channel: TransformChannel, next: AnimatableNumber) => void;
}): ReactNode {
  const animated = isAnimated(value);
  const now = evaluateAt(value, at);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{spec.label}</span>
        {spec.unit !== undefined && <span className="text-xs text-muted-foreground/60">{spec.unit}</span>}
        <span className={cn('ml-auto font-mono text-xs tabular-nums', animated && 'text-primary')}>
          {now.toFixed(2)}
        </span>
        {/* Animating is an explicit act, as it is everywhere else here: a value that silently became
            keyframed on first edit would surprise anyone who only meant to change it once. */}
        <Toggle
          size="sm"
          pressed={animated}
          aria-label={animated ? `Stop animating ${spec.label}` : `Animate ${spec.label}`}
          title={animated ? 'Return this to a constant value' : 'Animate this with keyframes'}
          onPressedChange={() =>
            onWrite(
              animated ? `un-animate ${spec.label}` : `animate ${spec.label}`,
              spec.channel,
              // Un-animating keeps the value *at the playhead*: the number the user is looking at when
              // they press the button is the one they mean to keep.
              animated
                ? staticNumber(now)
                : animatedNumber([
                    { id: keyframeId(`${spec.channel}_0`), frame: frameIndex(0), value: now, ease: 'linear' },
                  ]),
            )
          }
        >
          <DiamondIcon />
        </Toggle>
      </div>

      <div className="flex items-center gap-2">
        {/* The name lives in a wrapping label, not in an `aria-label`. The slider spreads its props
            onto its root, and the control that needs naming is the range input inside its thumb — so
            an attribute here reached nothing and all five of these were nameless. The visible row
            label says the same word, which is why this copy is `sr-only`. */}
        <Label className="flex-1">
          <span className="sr-only">{spec.label}</span>
          <Slider
            disabled={animated}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            // The array form even for one value: given a scalar the registry falls back to `[min, max]`
            // and renders a second thumb.
            value={[clampToSlider(now, spec)]}
            onValueChange={(next) => onWrite(`set ${spec.label}`, spec.channel, staticNumber(scalar(next)))}
            className="w-full"
          />
        </Label>
        {/* The number takes values the slider does not span — scaling to 8× is legitimate, and the
            slider stopping at 4 is a convenience rather than a rule. */}
        <NumberField
          aria-label={`${spec.label} value`}
          disabled={animated}
          step={spec.step}
          value={roundTo(now, spec.step)}
          onCommit={(next) => onWrite(`set ${spec.label}`, spec.channel, staticNumber(next))}
          className="w-19 font-mono tabular-nums"
        />
      </div>

      {animated && (
        <p className="font-mono text-xs text-muted-foreground">
          edited in the keyframe lane, so one value cannot win over another
        </p>
      )}
    </div>
  );
}

/**
 * The slider's position for a value it cannot reach.
 *
 * A number field or an authored curve can leave a channel outside the slider's range. Left alone the
 * thumb would sit at whichever end and read as *that* value; clamped, it sits at the end it is past,
 * which is at least true. The number beside it says what the value actually is.
 */
function clampToSlider(value: number, spec: TransformChannelSpec): number {
  return Math.min(spec.max, Math.max(spec.min, value));
}

function scalar(next: number | readonly number[]): number {
  return Array.isArray(next) ? (next[0] ?? 0) : (next as number);
}

/**
 * The value as the field should show it.
 *
 * Rounded to the channel's own step, so dragging a 0.01-step slider does not put `0.30000000000000004`
 * in a box the user is about to type into.
 */
function roundTo(value: number, step: number): number {
  const places = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(value.toFixed(places));
}
