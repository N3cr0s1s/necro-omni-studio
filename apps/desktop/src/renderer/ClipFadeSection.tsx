import type { ReactNode } from 'react';
import { TrendingDownIcon, TrendingUpIcon } from 'lucide-react';
import {
  type Clip,
  type Easing,
  type TimelineDocument,
  DEFAULT_BEZIER,
  clipFade,
  formatFrames,
  frameIndex,
} from '@nos/core';
import { describeEditError, maxFadeFrames, setGroupFade } from '@nos/editing';
import { NumberField } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { cn } from '@nos/ui/lib/utils';
import { BezierEditor } from './BezierEditor.js';

/**
 * A clip's edge ramps, as numbers.
 *
 * The handles on the clip are the gesture and this is the frame-accurate way to say the same thing —
 * the rule §6.1 states for every other duration in the editor: *a value that can be dragged must also
 * be typeable*. A drag cannot land on frame 12, nor say which frame it landed on.
 *
 * Both fields are offered on every clip kind, because a ramp means something in both domains: level
 * for a sound, opacity for a picture. Text is the one that reads oddly at first and is right on
 * reflection — a title that appears instantly and one that fades up are different titles, and the
 * compositor already multiplies the ramp into the layer's opacity.
 *
 * There is no "fade to black" alternative offered here. A fade *is* to transparent, and what is
 * behind it is whatever the tracks below hold — which is black on the bottom row and the previous
 * shot on any other. Offering the two as separate choices would be claiming a distinction the
 * compositor does not have.
 */

/**
 * The curves a ramp can follow.
 *
 * `default` first and unlabelled by any easing name, because it is not one: it is *each renderer's
 * own* answer, and they differ — sound crossfades equal-power and picture crossfades linear, because
 * the two sum differently. Naming it `linear` would be a lie on the audio side, and offering only the
 * easings would make the right answer unreachable.
 *
 * The rest are the same names a keyframe uses, deliberately. A ramp and a keyframe segment are the
 * same question, and a second vocabulary for it would be a second thing to learn and a second
 * evaluator to keep honest.
 */
const FADE_SHAPES: readonly {
  readonly id: Easing | undefined;
  readonly label: string;
  readonly help: string;
}[] = [
  { id: undefined, label: 'default', help: 'equal power for sound, linear for picture' },
  { id: 'linear', label: 'linear', help: 'a constant rate across the ramp' },
  { id: 'ease-in', label: 'ease-in', help: 'starts slowly' },
  { id: 'ease-out', label: 'ease-out', help: 'arrives slowly' },
  { id: 'ease-in-out', label: 'ease-io', help: 'slow at both ends' },
  { id: 'bezier', label: 'curve', help: 'a curve you draw yourself' },
];

export interface ClipFadeSectionProps {
  readonly document: TimelineDocument;
  readonly clip: Clip;
  readonly onChange: (label: string, next: TimelineDocument) => void;
  /** Surfaces a refusal: a locked track legitimately rejects one of these. */
  readonly onReject?: ((reason: string) => void) | undefined;
}

export function ClipFadeSection({ document, clip, onChange, onReject }: ClipFadeSectionProps): ReactNode {
  const fade = clipFade(clip);
  const limit = maxFadeFrames(clip);

  const commit = (label: string, result: ReturnType<typeof setGroupFade>): void => {
    if (result.ok) onChange(label, result.value);
    else onReject?.(describeEditError(result.error));
  };

  return (
    <section aria-label="Fade" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Fade</span>
        {(fade.inFrames > 0 || fade.outFrames > 0) && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto h-5 px-1.5 text-[11px]"
            title="Remove both ramps"
            onClick={() =>
              commit('clear clip fade', setGroupFade(document, clip.id, { inFrames: 0, outFrames: 0 }))
            }
          >
            clear
          </Button>
        )}
      </div>

      <FadeRow
        label="in"
        icon={TrendingUpIcon}
        value={fade.inFrames}
        limit={limit}
        rate={document.frameRate}
        onCommit={(next) => commit('set fade in', setGroupFade(document, clip.id, { inFrames: next }))}
      />
      <FadeRow
        label="out"
        icon={TrendingDownIcon}
        value={fade.outFrames}
        limit={limit}
        rate={document.frameRate}
        onCommit={(next) => commit('set fade out', setGroupFade(document, clip.id, { outFrames: next }))}
      />

      {/* Offered only once there is a ramp: a curve for a fade that does not exist describes nothing,
          and a control that cannot change what you see teaches you to ignore the panel. */}
      {(fade.inFrames > 0 || fade.outFrames > 0) && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">curve</span>
          <div role="radiogroup" aria-label="fade curve" className="flex flex-wrap gap-1">
            {FADE_SHAPES.map(({ id, label, help }) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={(fade.shape ?? undefined) === id}
                title={help}
                onClick={() =>
                  commit(
                    'set fade curve',
                    setGroupFade(document, clip.id, {
                      ...(id === undefined ? { shape: undefined } : { shape: id }),
                      ...(id === 'bezier' ? { shapeBezier: fade.shapeBezier ?? DEFAULT_BEZIER } : {}),
                    }),
                  )
                }
                className={cn(
                  'rounded border px-1.5 py-0.5 font-mono text-[10px]',
                  (fade.shape ?? undefined) === id
                    ? 'border-primary bg-primary/20 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {fade.shape === 'bezier' && (
            <BezierEditor
              points={fade.shapeBezier ?? DEFAULT_BEZIER}
              // `onCommit`, not `onChange`: a drag across the box is one edit, and the live channel
              // would bury whatever came before it under an entry per pointer move.
              onCommit={(points) =>
                commit('set fade curve', setGroupFade(document, clip.id, { shapeBezier: points }))
              }
            />
          )}
        </div>
      )}
    </section>
  );
}

function FadeRow({
  label,
  icon: Icon,
  value,
  limit,
  rate,
  onCommit,
}: {
  readonly label: string;
  readonly icon: typeof TrendingUpIcon;
  readonly value: number;
  readonly limit: number;
  readonly rate: TimelineDocument['frameRate'];
  readonly onCommit: (next: number) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-14 text-xs text-muted-foreground">{label}</span>
      <NumberField
        aria-label={`fade ${label}`}
        value={value}
        step={1}
        min={0}
        max={limit}
        // Committed on Enter and on blur, like every other frame field: typing `24` passes through
        // `2`, and a ramp that jumped to two frames on the way is an edit nobody asked for.
        onCommit={(next) => {
          const whole = Math.round(next);
          if (whole !== value) onCommit(whole);
        }}
        className="w-20 font-mono tabular-nums"
      />
      {/* The duration rather than the timecode: a ramp is a length, and reading it as a position on
          the timeline would be reading it against the wrong origin. */}
      <span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
        {formatFrames(frameIndex(Math.max(0, value)), rate)}
      </span>
    </div>
  );
}
