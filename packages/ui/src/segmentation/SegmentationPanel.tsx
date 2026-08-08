import { type MouseEvent, type ReactNode } from 'react';
import {
  CircleSlashIcon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  ScanIcon,
  SquareDashedIcon,
  XIcon,
} from 'lucide-react';
import {
  type FrameIndex,
  type FrameSpan,
  endExclusive,
  frameIndex,
  spanFromBounds,
  clamp01,
} from '@nos/core';
import {
  type MaskPrompt,
  type MaskSession,
  type SegmentationCapabilities,
  coveredSpans,
  describeSession,
} from '@nos/masks';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import { Field, FieldLabel } from '@nos/ui/components/ui/field';
import { Input } from '@nos/ui/components/ui/input';
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia } from '@nos/ui/components/ui/item';
import { Separator } from '@nos/ui/components/ui/separator';
import { cn } from '@nos/ui/lib/utils';

/**
 * Segmentation (mockup 1e).
 *
 * The spec's interaction: click the object on a frame, adjust the propagation range, run, watch the masks
 * appear. Three properties this component is built around:
 *
 * - **Clicks are normalized.** A point placed on a 720p proxy has to mean the same thing when the mask is
 *   produced at master resolution, so coordinates are `[0, 1]` and never pixels.
 * - **Negative clicks are first class.** "This, but not that" is what separates a person from the wall
 *   behind them; a UI offering only positive clicks makes the common case impossible.
 * - **An unavailable engine is greyed with its reason**, never hidden — the same rule the generator
 *   registry follows, because SAM 2 is an optional install and its absence must be legible.
 */

export interface SegmentationPanelProps {
  readonly session: MaskSession;
  readonly capabilities?: SegmentationCapabilities | undefined;
  readonly onRun?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly onRemovePrompt?: ((index: number) => void) | undefined;
  readonly onChangePropagation?: ((span: FrameSpan) => void) | undefined;
  readonly onSeek?: ((frame: FrameIndex) => void) | undefined;
}

export function SegmentationPanel({
  session,
  capabilities,
  onRun,
  onCancel,
  onRemovePrompt,
  onChangePropagation,
  onSeek,
}: SegmentationPanelProps): ReactNode {
  const unavailable = capabilities !== undefined && !capabilities.available;
  const canRun = !unavailable && !session.running && session.track.prompts.length > 0;

  return (
    <section
      aria-label="Segmentation"
      className={cn(
        'flex w-full flex-col gap-4',
        // Readable while greyed: the point is that the user can see what is wrong, not merely that
        // something is.
        unavailable && 'opacity-75',
      )}
    >
      <div className="flex h-9 flex-none items-center gap-3 px-4">
        <ScanIcon className="size-3.5 text-chart-4" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Segmentation
        </span>
        <Badge variant={unavailable ? 'destructive' : 'secondary'} className="ml-auto">
          {unavailable ? 'unavailable' : 'SAM 2'}
        </Badge>
      </div>
      <Separator className="-mt-4" />

      <div className="flex flex-col gap-4 px-4">
        {unavailable && (
          <p className="flex items-start gap-1.5 font-mono text-xs text-destructive">
            <CircleSlashIcon className="mt-0.5 size-3.5 shrink-0" />
            {capabilities?.detail ?? 'segmentation is unavailable'}
          </p>
        )}

        <p
          className={cn(
            'font-mono text-xs',
            session.error !== undefined ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {describeSession(session)}
        </p>

        <PromptList
          prompts={session.track.prompts}
          disabled={unavailable}
          {...(onRemovePrompt !== undefined ? { onRemove: onRemovePrompt } : {})}
          {...(onSeek !== undefined ? { onSeek } : {})}
        />

        <PropagationBar
          session={session}
          disabled={unavailable}
          {...(onChangePropagation !== undefined ? { onChange: onChangePropagation } : {})}
        />

        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!canRun}
            onClick={onRun}
            title={runTitle(session, unavailable)}
            className="flex-1"
          >
            <PlayIcon />
            {session.frames.size > 0 ? 'Re-run' : 'Segment'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!session.running}
            onClick={onCancel}
            title="Stop, keeping the frames already masked"
          >
            Cancel
          </Button>
        </div>
      </div>
    </section>
  );
}

function runTitle(session: MaskSession, unavailable: boolean): string {
  if (unavailable) return 'segmentation is unavailable';
  if (session.track.prompts.length === 0) return 'click the object on the preview first';
  return 'propagate the mask over the range';
}

/**
 * The prompts, listed.
 *
 * Each row seeks to the frame it was placed on. Without that, a prompt made twenty seconds earlier is
 * effectively unreachable — the user can see it exists and cannot get back to it to judge or remove it.
 */
function PromptList({
  prompts,
  disabled,
  onRemove,
  onSeek,
}: {
  readonly prompts: readonly MaskPrompt[];
  readonly disabled: boolean;
  readonly onRemove?: (index: number) => void;
  readonly onSeek?: (frame: FrameIndex) => void;
}): ReactNode {
  if (prompts.length === 0) {
    return (
      <p className="font-mono text-xs text-muted-foreground">
        click the object on the preview — alt-click to exclude
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Prompts</span>
      <ItemGroup aria-label="Prompts" role="list" className="gap-0.5">
        {prompts.map((prompt, index) => {
          const excluding = prompt.kind === 'point' && !prompt.include;
          const PromptIcon = prompt.kind !== 'point' ? SquareDashedIcon : excluding ? MinusIcon : PlusIcon;
          // Named, not merely coloured: which prompts include and which exclude is the whole content of
          // this list, and a red dash says nothing to a screen reader.
          const kind = prompt.kind !== 'point' ? 'box' : excluding ? 'exclude' : 'include';

          return (
            <Item
              key={`${prompt.kind}-${prompt.frame}-${index}`}
              role="listitem"
              size="xs"
              className="py-0.5"
            >
              <ItemMedia>
                <PromptIcon
                  role="img"
                  aria-label={kind}
                  className={cn('size-3.5', excluding ? 'text-destructive' : 'text-chart-4')}
                />
              </ItemMedia>
              <ItemContent>
                <Button
                  variant="link"
                  size="xs"
                  onClick={() => onSeek?.(prompt.frame)}
                  className="h-auto justify-start px-0 font-mono text-xs text-muted-foreground"
                >
                  frame {prompt.frame}
                </Button>
              </ItemContent>
              <ItemActions>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  onClick={() => onRemove?.(index)}
                  title="Remove this prompt"
                  aria-label={`Remove prompt at frame ${prompt.frame}`}
                >
                  <XIcon />
                </Button>
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </div>
  );
}

/**
 * The propagation range bar.
 *
 * Shows three things at once: the clip's range, the sub-range that will be propagated, and which frames
 * already have a mask. The third is what makes a long run bearable — the fill grows as the work lands, so
 * a stalled propagation is visible immediately rather than after the timeout.
 *
 * Drawn from absolute positions rather than assembled from registry parts, because there is no component
 * for "three overlapping ranges over one axis" and inventing one out of `Progress` would be a worse lie
 * than a plain box. The colours are still only roles.
 */
export function PropagationBar({
  session,
  disabled,
  width = 300,
  height = 22,
  onChange,
}: {
  readonly session: MaskSession;
  readonly disabled?: boolean | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly onChange?: ((span: FrameSpan) => void) | undefined;
}): ReactNode {
  const clip = session.track.range;
  const total = clip.duration;
  const toX = (frame: number): number => ((frame - clip.start) / Math.max(1, total)) * width;

  const start = session.propagation.start;
  const end = endExclusive(session.propagation);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Propagate</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{`${start}–${end}`}</span>
      </div>

      <div
        role="group"
        aria-label="Propagation range"
        className="relative overflow-hidden rounded-md border border-input bg-muted"
        style={{ width, height }}
      >
        <div
          role="presentation"
          className="absolute inset-y-0 border-x border-chart-4 bg-chart-4/15"
          style={{ left: toX(start), width: Math.max(2, toX(end) - toX(start)) }}
        />

        {coveredSpans(session).map((span) => (
          <div
            key={`${span.start}-${span.duration}`}
            role="presentation"
            data-testid="covered-span"
            className="absolute bottom-0 h-1 bg-chart-4"
            style={{
              left: toX(span.start),
              width: Math.max(1, toX(endExclusive(span)) - toX(span.start)),
            }}
          />
        ))}

        <div
          role="presentation"
          className="absolute inset-y-0 w-px bg-primary"
          style={{ left: toX(session.frame) }}
        />
      </div>

      <div className="flex gap-2">
        <FrameField
          label="From"
          value={start}
          disabled={disabled === true}
          onChange={(value) => onChange?.(spanFromBounds(frameIndex(value), frameIndex(end)))}
        />
        <FrameField
          label="To"
          value={end}
          disabled={disabled === true}
          onChange={(value) => onChange?.(spanFromBounds(frameIndex(start), frameIndex(value)))}
        />
      </div>
    </div>
  );
}

function FrameField({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}): ReactNode {
  return (
    <Field orientation="horizontal" className="w-auto gap-2">
      <FieldLabel htmlFor={`propagate-${label}`} className="shrink-0 text-xs">
        {label}
      </FieldLabel>
      <Input
        id={`propagate-${label}`}
        type="number"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-7 w-20 font-mono tabular-nums"
      />
    </Field>
  );
}

/**
 * The click overlay on the preview.
 *
 * Coordinates are normalized against the element's own box, so the same click means the same thing at any
 * preview size and on a proxy — a pixel coordinate would put every mask somewhere else the moment the
 * window is resized.
 */
export function MaskPointOverlay({
  session,
  width,
  height,
  disabled = false,
  onAddPrompt,
  onRemovePrompt,
}: {
  readonly session: MaskSession;
  readonly width: number;
  readonly height: number;
  readonly disabled?: boolean | undefined;
  readonly onAddPrompt?: ((prompt: MaskPrompt) => void) | undefined;
  readonly onRemovePrompt?: ((index: number) => void) | undefined;
}): ReactNode {
  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    if (disabled) return;
    const box = event.currentTarget.getBoundingClientRect();
    // Guard against a zero-sized box during layout: dividing by it would place every point at Infinity.
    if (box.width === 0 || box.height === 0) return;

    onAddPrompt?.({
      kind: 'point',
      frame: session.frame,
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height),
      // Alt-click excludes. A modifier rather than a mode: the two kinds of click alternate constantly
      // while refining a selection, and a mode toggle turns every correction into two actions.
      include: !event.altKey,
    });
  }

  const onFrame = session.track.prompts
    .map((prompt, index) => ({ prompt, index }))
    .filter(({ prompt }) => prompt.frame === session.frame);

  return (
    <div
      role="group"
      aria-label="Mask points"
      onClick={handleClick}
      className={cn('relative', disabled ? 'cursor-default' : 'cursor-crosshair')}
      style={{ width, height }}
    >
      {onFrame.map(({ prompt, index }) => {
        if (prompt.kind !== 'point') return null;
        return (
          <button
            key={`${index}-${prompt.x}-${prompt.y}`}
            type="button"
            aria-label={`${prompt.include ? 'Include' : 'Exclude'} point at frame ${prompt.frame}`}
            onClick={(event) => {
              // Stops the overlay from adding a new point where the user meant to remove one.
              event.stopPropagation();
              if (!disabled) onRemovePrompt?.(index);
            }}
            className={cn(
              'absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 p-0',
              prompt.include ? 'border-chart-4/60 bg-chart-4' : 'border-destructive bg-transparent',
            )}
            style={{ left: `${prompt.x * 100}%`, top: `${prompt.y * 100}%` }}
          />
        );
      })}
    </div>
  );
}
