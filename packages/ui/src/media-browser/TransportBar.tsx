import type { ReactNode } from 'react';
import { PauseIcon, PlayIcon, SkipBackIcon, Volume2Icon, VolumeXIcon } from 'lucide-react';
import { Button } from '@nos/ui/components/ui/button';
import { Label } from '@nos/ui/components/ui/label';
import { Slider } from '@nos/ui/components/ui/slider';
import { cn } from '@nos/ui/lib/utils';
import { UNKNOWN_CLOCK, formatClock } from './media-clock.js';
import type { MediaTransportControls, MediaTransportState } from './use-media-transport.js';

/**
 * The controls under a preview.
 *
 * Built from the same primitives as the rest of the application rather than left to the browser's own
 * `controls` attribute. Chromium's bar is a fixed piece of chrome: it does not take the theme, it does
 * not match the buttons three centimetres above it, and its sizing is its own — so the one place a user
 * looks to hear a take was the one place that looked like a different program.
 */

export interface TransportBarProps {
  readonly state: MediaTransportState;
  readonly controls: MediaTransportControls;
  /** Names the controls for a screen reader, since the file's own name is all that identifies it. */
  readonly label: string;
  readonly className?: string | undefined;
}

export function TransportBar({ state, controls, label, className }: TransportBarProps): ReactNode {
  const { currentSeconds, durationSeconds, muted, playing } = state;
  const scrubbable = durationSeconds !== undefined;

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={controls.toggle}
        disabled={!state.ready}
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={controls.restart}
        disabled={!state.ready}
        aria-label={`Restart ${label}`}
      >
        <SkipBackIcon />
      </Button>

      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {formatClock(currentSeconds)}
      </span>

      {/* Wrapped in a label rather than given an `aria-label`: the slider spreads its props onto its
          root, and the thing that needs a name is the range input the root renders inside its thumb.
          An implicit label association reaches it; an attribute on the root does not. */}
      <Label className={cn('flex-1', !scrubbable && 'opacity-40')}>
        <span className="sr-only">Seek {label}</span>
        <Slider
          // One-element array, always. Handed a bare number the component falls back to `[min, max]`
          // and renders two thumbs, which on a scrubber reads as a range selection nothing can undo.
          value={[Math.min(currentSeconds, durationSeconds ?? currentSeconds)]}
          min={0}
          max={durationSeconds ?? 1}
          step={0.05}
          disabled={!scrubbable}
          onValueChange={(next) => {
            const seconds = Array.isArray(next) ? next[0] : next;
            if (typeof seconds === 'number') controls.seek(seconds);
          }}
          className="w-full"
        />
      </Label>

      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {scrubbable ? formatClock(durationSeconds) : UNKNOWN_CLOCK}
      </span>

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={controls.toggleMuted}
        aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
      >
        {muted ? <VolumeXIcon /> : <Volume2Icon />}
      </Button>
    </div>
  );
}
