import type { ReactNode } from 'react';
import { TrendingDownIcon, TrendingUpIcon } from 'lucide-react';
import { type Clip, type TimelineDocument, clipFade, formatFrames, frameIndex } from '@nos/core';
import { clearClipFade, describeEditError, maxFadeFrames, setClipFade } from '@nos/editing';
import { NumberField } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';

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

  const commit = (label: string, result: ReturnType<typeof setClipFade>): void => {
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
            onClick={() => commit('clear clip fade', clearClipFade(document, clip.id))}
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
        onCommit={(next) => commit('set fade in', setClipFade(document, clip.id, { inFrames: next }))}
      />
      <FadeRow
        label="out"
        icon={TrendingDownIcon}
        value={fade.outFrames}
        limit={limit}
        rate={document.frameRate}
        onCommit={(next) => commit('set fade out', setClipFade(document, clip.id, { outFrames: next }))}
      />
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
