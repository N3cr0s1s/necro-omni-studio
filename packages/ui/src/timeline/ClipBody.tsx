import type { CSSProperties, ReactNode } from 'react';
import { type Clip, type ClipId, isGenerated, passCount } from '@nos/core';
import { token } from '../tokens/tokens.js';
import type { ClipStrip } from './clip-strip.js';
import { type SpanGeometry } from './viewport.js';

/**
 * A clip drawn on a track.
 *
 * The visual language is the mockups': a video clip is a blue gradient with a filmstrip strip along
 * its bottom, audio is teal with a waveform, text is amber, and **anything a generator produced is
 * purple** regardless of its media type. That last rule is the one worth guarding — it is how a user
 * tells at a glance which material is synthetic, and it must hold on the timeline, in the browser and
 * in the inspector alike.
 */

export interface ClipBodyProps {
  readonly clip: Clip;
  readonly geometry: SpanGeometry;
  readonly heightPx: number;
  readonly selected: boolean;
  /** Filmstrip or waveform image and its placement, once derived. Absent means not ready yet. */
  readonly strip?: ClipStrip;
  readonly onPointerDown?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onTrimStart?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onTrimEnd?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  /** Above the spec's 8-pass budget, the clip carries a warning badge. */
  readonly passWarningThreshold?: number;
}

/** Fill and border for a clip, by media kind and provenance. */
function clipPalette(clip: Clip): { readonly fill: string; readonly border: string } {
  const generated = isGenerated(clip);

  switch (clip.kind) {
    case 'video':
    case 'image':
      return generated
        ? { fill: 'var(--nos-clip-generated-fill)', border: 'var(--nos-clip-generated-border)' }
        : { fill: 'var(--nos-clip-video-fill)', border: 'var(--nos-clip-video-border)' };
    case 'audio':
      return generated
        ? {
            fill: 'var(--nos-clip-audio-generated-fill)',
            border: 'var(--nos-clip-generated-border)',
          }
        : { fill: 'var(--nos-clip-audio-fill)', border: 'var(--nos-clip-audio-border)' };
    case 'text':
      return { fill: 'var(--nos-clip-text-fill)', border: 'var(--nos-clip-text-border)' };
    default: {
      const unreachable: never = clip;
      throw new Error(`Unhandled clip kind ${JSON.stringify(unreachable)}`);
    }
  }
}

function labelColor(clip: Clip): string {
  if (isGenerated(clip)) return token.generatedText;
  switch (clip.kind) {
    case 'audio':
      return token.okText;
    case 'text':
      return token.warnText;
    default:
      return '#c6d3ee';
  }
}

/** Trim handles need enough width to grab; below this a clip is body-only. */
const TRIM_HANDLE_PX = 6;
const MIN_HANDLE_CLIP_WIDTH_PX = 24;

export function ClipBody({
  clip,
  geometry,
  heightPx,
  selected,
  strip,
  onPointerDown,
  onTrimStart,
  onTrimEnd,
  passWarningThreshold = 8,
}: ClipBodyProps): ReactNode {
  const palette = clipPalette(clip);
  const passes = passCount(clip);
  const showHandles = geometry.widthPx >= MIN_HANDLE_CLIP_WIDTH_PX;

  const style: CSSProperties = {
    position: 'absolute',
    left: geometry.leftPx,
    width: geometry.widthPx,
    top: 6,
    height: Math.max(0, heightPx - 12),
    borderRadius: token.radiusControl,
    background: selected ? 'var(--nos-clip-video-selected-fill)' : palette.fill,
    border: selected ? `2px solid ${token.accent}` : `1px solid ${palette.border}`,
    boxShadow: selected ? '0 0 0 1px rgba(76, 154, 255, 0.25)' : 'none',
    overflow: 'hidden',
    padding: '5px 7px',
    boxSizing: 'border-box',
    opacity: clip.enabled ? 1 : 0.4,
    // No transition: this element moves under the pointer during a drag, and any easing would fight
    // the gesture and blow the 16 ms interaction budget.
    cursor: 'grab',
    userSelect: 'none',
  };

  return (
    <div
      role="button"
      aria-label={clipAccessibleLabel(clip)}
      aria-pressed={selected}
      tabIndex={0}
      data-clip-id={clip.id}
      data-generated={isGenerated(clip) ? 'true' : 'false'}
      style={style}
      onPointerDown={(event) => onPointerDown?.(clip.id, event)}
    >
      {/* First, so everything else paints over it: an audio strip fills the clip, and a waveform
          drawn on top of the label would hide the one thing that names the clip. */}
      {strip !== undefined && <StripLayer clip={clip} strip={strip} />}

      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: token.space2,
          minWidth: 0,
        }}
      >
        {isGenerated(clip) && (
          <span aria-hidden="true" style={{ font: '400 9px sans-serif', color: token.generated }}>
            ✦
          </span>
        )}
        <span
          style={{
            font: token.textClip,
            color: labelColor(clip),
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {clip.label}
        </span>
        {passes > 0 && (
          <ClipChip tone={passes > passWarningThreshold ? 'warn' : 'ok'} label={`fx ${passes}`} />
        )}
        {clip.effects.some((effect) => effect.mask !== undefined) && <ClipChip tone="mask" label="mask" />}
      </div>

      {clip.provenance?.seed !== undefined && geometry.widthPx > 90 && (
        <div
          style={{
            position: 'absolute',
            left: 7,
            bottom: 4,
            font: token.textMeta,
            color: token.generatedDim,
          }}
        >
          seed {clip.provenance.seed}
        </div>
      )}

      {showHandles && (
        <>
          <TrimHandle side="start" onPointerDown={(event) => onTrimStart?.(clip.id, event)} />
          <TrimHandle side="end" onPointerDown={(event) => onTrimEnd?.(clip.id, event)} />
        </>
      )}
    </div>
  );
}

/**
 * The filmstrip or waveform behind a clip's label.
 *
 * An `<img>` inside a clipping box rather than a background image, because the placement is a
 * fraction of the clip's width and CSS background percentages resolve against the *difference*
 * between the image and its box, not against the box. Percentage `width` and `left` on a child do
 * resolve against the box, which is exactly the arithmetic `ClipStrip` describes.
 *
 * Audio fills the clip and video sits along the bottom: a waveform is the clip's whole content,
 * where a filmstrip is a band under a label that still has to be readable.
 */
function StripLayer({ clip, strip }: { readonly clip: Clip; readonly strip: ClipStrip }): ReactNode {
  const audio = clip.kind === 'audio';

  return (
    <div
      aria-hidden="true"
      data-strip-kind={audio ? 'waveform' : 'filmstrip'}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: audio ? '100%' : 34,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <img
        src={strip.url}
        alt=""
        draggable={false}
        style={{
          position: 'absolute',
          top: 0,
          height: '100%',
          width: `${strip.widths * 100}%`,
          left: `${-strip.offset * 100}%`,
          maxWidth: 'none',
          opacity: 0.85,
        }}
      />
    </div>
  );
}

function ClipChip({
  tone,
  label,
}: {
  readonly tone: 'ok' | 'warn' | 'mask';
  readonly label: string;
}): ReactNode {
  const palette = {
    ok: { fg: '#6fd8bf', bg: 'rgba(56, 193, 164, 0.16)' },
    warn: { fg: token.warnText, bg: 'rgba(224, 164, 74, 0.2)' },
    mask: { fg: '#ff9c7a', bg: 'rgba(255, 122, 82, 0.16)' },
  }[tone];

  return (
    <span
      style={{
        height: 13,
        padding: '0 5px',
        borderRadius: 7,
        background: palette.bg,
        color: palette.fg,
        font: `500 8.5px ${token.fontMono}`,
        lineHeight: '13px',
        flex: 'none',
      }}
    >
      {label}
    </span>
  );
}

/**
 * A grab area at a clip edge.
 *
 * Rendered inside the clip rather than as a sibling so it moves with the clip automatically, and
 * `pointerdown` stops propagating so grabbing the edge trims instead of starting a move.
 */
function TrimHandle({
  side,
  onPointerDown,
}: {
  readonly side: 'start' | 'end';
  readonly onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}): ReactNode {
  return (
    <div
      data-trim-handle={side}
      aria-hidden="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(event);
      }}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: TRIM_HANDLE_PX,
        ...(side === 'start' ? { left: 0 } : { right: 0 }),
        cursor: 'ew-resize',
        background: 'transparent',
      }}
    />
  );
}

/**
 * Accessible name for a clip.
 *
 * Includes provenance and effect count because those are conveyed visually by colour and a badge,
 * neither of which reaches a screen reader.
 */
export function clipAccessibleLabel(clip: Clip): string {
  const parts = [clip.label || clip.kind];
  if (isGenerated(clip)) parts.push('generated');
  const passes = passCount(clip);
  if (passes > 0) parts.push(`${passes} effect${passes === 1 ? '' : 's'}`);
  if (!clip.enabled) parts.push('disabled');
  return parts.join(', ');
}
