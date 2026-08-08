import { type MouseEvent, type ReactNode } from 'react';
import { type FrameIndex, type FrameSpan, endExclusive, frameIndex, spanFromBounds } from '@nos/core';
import {
  type MaskPrompt,
  type MaskSession,
  type SegmentationCapabilities,
  coveredSpans,
  describeSession,
} from '@nos/masks';
import { Badge, Button, Mono, PanelHeader, SectionCaption } from '../primitives/Primitives.js';
import { token } from '../tokens/tokens.js';

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
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: token.space4,
        // Fills its column rather than dictating it: the panel is mounted inside a resizable inspector,
        // and a fixed width there overflows by exactly the padding.
        width: '100%',
        maxWidth: token.inspectorWidth,
        background: token.bgPanel,
        borderLeft: `1px solid ${token.border}`,
        // Readable while greyed: the point is that the user can see what is wrong, not merely that
        // something is.
        opacity: unavailable ? 0.75 : 1,
      }}
    >
      <PanelHeader
        caption="Segmentation"
        trailing={
          <Badge tone={unavailable ? 'danger' : 'mask'}>{unavailable ? 'unavailable' : 'SAM 2'}</Badge>
        }
      />

      <div
        style={{ display: 'flex', flexDirection: 'column', gap: token.space4, padding: `0 ${token.space5}` }}
      >
        {unavailable && (
          <Mono tone={token.danger}>{capabilities?.detail ?? 'segmentation is unavailable'}</Mono>
        )}

        <Mono tone={session.error !== undefined ? token.danger : token.textFaint}>
          {describeSession(session)}
        </Mono>

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

        <div style={{ display: 'flex', gap: token.space2 }}>
          <Button
            tone="primary"
            disabled={!canRun}
            onClick={onRun}
            title={runTitle(session, unavailable)}
            style={{ flex: 1, justifyContent: 'center' }}
          >
            {session.frames.size > 0 ? 'Re-run' : 'Segment'}
          </Button>
          <Button
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
    return <Mono tone={token.textGhost}>click the object on the preview — alt-click to exclude</Mono>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space2 }}>
      <SectionCaption>Prompts</SectionCaption>
      <ul aria-label="Prompts" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {prompts.map((prompt, index) => (
          <li
            key={`${prompt.kind}-${prompt.frame}-${index}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: token.space2,
              height: token.controlHeightSm,
            }}
          >
            <Badge tone={prompt.kind === 'point' && !prompt.include ? 'danger' : 'mask'}>
              {prompt.kind === 'point' ? (prompt.include ? '+' : '−') : '□'}
            </Badge>
            <button
              type="button"
              onClick={() => onSeek?.(prompt.frame)}
              style={{
                flex: 1,
                textAlign: 'left',
                background: 'none',
                border: 'none',
                color: token.textSecondary,
                font: token.textMeta,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              frame {prompt.frame}
            </button>
            <Button
              disabled={disabled}
              onClick={() => onRemove?.(index)}
              title="Remove this prompt"
              style={{ height: token.controlHeightSm, padding: `0 ${token.space2}` }}
            >
              ×
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The propagation range bar.
 *
 * Shows three things at once: the clip's range, the sub-range that will be propagated, and which frames
 * already have a mask. The third is what makes a long run bearable — the fill grows as the work lands, so
 * a stalled propagation is visible immediately rather than after the timeout.
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: token.space3 }}>
        <SectionCaption>Propagate</SectionCaption>
        <div style={{ flex: 1 }} />
        <Mono tone={token.textFaint}>{`${start}–${end}`}</Mono>
      </div>

      <div
        role="group"
        aria-label="Propagation range"
        style={{
          position: 'relative',
          width,
          height,
          background: token.surface1,
          border: `1px solid ${token.borderControl}`,
          borderRadius: token.radiusInset,
          overflow: 'hidden',
        }}
      >
        <div
          role="presentation"
          style={{
            position: 'absolute',
            left: toX(start),
            width: Math.max(2, toX(end) - toX(start)),
            top: 0,
            bottom: 0,
            background: 'rgba(255, 122, 82, 0.14)',
            borderLeft: `1px solid ${token.mask}`,
            borderRight: `1px solid ${token.mask}`,
          }}
        />

        {coveredSpans(session).map((span) => (
          <div
            key={`${span.start}-${span.duration}`}
            role="presentation"
            data-testid="covered-span"
            style={{
              position: 'absolute',
              left: toX(span.start),
              width: Math.max(1, toX(endExclusive(span)) - toX(span.start)),
              bottom: 0,
              height: 5,
              background: token.mask,
            }}
          />
        ))}

        <div
          role="presentation"
          style={{
            position: 'absolute',
            left: toX(session.frame),
            top: 0,
            bottom: 0,
            width: 1,
            background: token.accent,
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: token.space2 }}>
        <NumberField
          label="From"
          value={start}
          disabled={disabled === true}
          onChange={(value) => onChange?.(spanFromBounds(frameIndex(value), frameIndex(end)))}
        />
        <NumberField
          label="To"
          value={end}
          disabled={disabled === true}
          onChange={(value) => onChange?.(spanFromBounds(frameIndex(start), frameIndex(value)))}
        />
      </div>
    </div>
  );
}

function NumberField({
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
    <label style={{ display: 'flex', alignItems: 'center', gap: token.space2 }}>
      <span style={{ font: token.textLabel, color: token.textSoft }}>{label}</span>
      <input
        type="number"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{
          width: 72,
          height: token.controlHeightSm,
          background: token.surface1,
          border: `1px solid ${token.borderControl}`,
          borderRadius: token.radiusControl,
          color: token.textBright,
          font: token.textValue,
          padding: `0 ${token.space2}`,
        }}
      />
    </label>
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
      style={{ position: 'relative', width, height, cursor: disabled ? 'default' : 'crosshair' }}
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
            style={{
              position: 'absolute',
              left: `${prompt.x * 100}%`,
              top: `${prompt.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: prompt.include ? token.mask : 'transparent',
              borderWidth: 2,
              borderStyle: 'solid',
              borderColor: prompt.include ? '#ffd0be' : token.danger,
              cursor: 'pointer',
              padding: 0,
            }}
          />
        );
      })}
    </div>
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
