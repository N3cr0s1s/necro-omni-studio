import { type ReactNode, useCallback, useMemo, useRef } from 'react';
import {
  type Clip,
  type ClipId,
  type FrameIndex,
  type FrameSpan,
  type Marker,
  type TimelineDocument,
  type Track,
  type TrackId,
  clipCount,
  documentEnd,
  endExclusive,
  frameIndex,
  isTrackAudible,
  trackClips,
} from '@nos/core';
import { Button, Divider, Mono, StatusDot } from '../primitives/Primitives.js';
import { token } from '../tokens/tokens.js';
import { ClipBody } from './ClipBody.js';
import type { ClipStrip } from './clip-strip.js';
import {
  type RulerTick,
  type TimelineViewport,
  formatTimelineStatus,
  formatZoom,
  frameToPx,
  generateTicks,
  isSpanVisible,
  pxToFrameFloor,
  spanGeometry,
} from './viewport.js';

/**
 * The timeline panel.
 *
 * Presentational: it draws a document through a viewport and reports gestures as frame-space
 * intentions. It never mutates — every edit goes through `@nos/editing` and the document store, so
 * undo, autosave and the 16 ms budget are all handled in one place rather than per interaction.
 *
 * The layout follows mockup 1a: a toolbar, then a fixed track-header column beside a scrolling lane
 * area with the ruler at its top and the playhead spanning all lanes.
 */

export interface TimelineProps {
  readonly document: TimelineDocument;
  readonly viewport: TimelineViewport;
  readonly playhead: FrameIndex;
  readonly selectedClips: ReadonlySet<string>;
  readonly snapEnabled: boolean;
  readonly rippleEnabled: boolean;

  /** Filmstrips and waveforms by clip id, supplied as derivations complete. */
  readonly strips?: ReadonlyMap<string, ClipStrip>;

  readonly onScrub?: (frame: FrameIndex) => void;
  readonly onSelectClip?: (clip: ClipId, additive: boolean) => void;
  readonly onClipPointerDown?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onTrimStart?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onTrimEnd?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onToggleSnap?: () => void;
  readonly onToggleRipple?: () => void;
  readonly onZoom?: (framesPerPixel: number, anchorPx: number) => void;
  readonly onAddTrack?: () => void;
  readonly onTrackMute?: (track: TrackId) => void;
  readonly onTrackSolo?: (track: TrackId) => void;
  readonly onTrackLock?: (track: TrackId) => void;

  /** In/out marks. Absent handlers hide the controls rather than showing dead ones. */
  readonly onMarkIn?: () => void;
  readonly onMarkOut?: () => void;
  readonly onClearRange?: () => void;
}

export function Timeline(props: TimelineProps): ReactNode {
  const { document, viewport, playhead } = props;
  const laneAreaRef = useRef<HTMLDivElement | null>(null);

  const ticks = useMemo(() => generateTicks(viewport), [viewport]);
  const totalFrames = documentEnd(document);

  /** Converts a pointer event to a frame, accounting for the lane area's own offset. */
  const frameFromEvent = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): FrameIndex => {
      const bounds = laneAreaRef.current?.getBoundingClientRect();
      const offsetPx = bounds === undefined ? event.clientX : event.clientX - bounds.left;
      // Floored, not rounded: a click inside the pixel column for frame N must mean N, or clicking a
      // clip's visible right edge would resolve to the gap past it.
      const frame = pxToFrameFloor(viewport, offsetPx);
      return frameIndex(Math.max(0, frame));
    },
    [viewport],
  );

  const handleRulerPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      props.onScrub?.(frameFromEvent(event));
    },
    [frameFromEvent, props],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      // Ctrl/Cmd + wheel is the near-universal zoom gesture; plain wheel stays available for
      // vertical scrolling through tracks.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = laneAreaRef.current?.getBoundingClientRect();
      const anchorPx = bounds === undefined ? 0 : event.clientX - bounds.left;
      const factor = event.deltaY > 0 ? 1.25 : 0.8;
      props.onZoom?.(viewport.framesPerPixel * factor, anchorPx);
    },
    [props, viewport.framesPerPixel],
  );

  const anySoloed = document.sequence.tracks.some((track) => track.solo);

  return (
    <section
      aria-label="Timeline"
      style={{
        height: token.timelineHeight,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: token.bgTimeline,
        borderTop: `1px solid ${token.border}`,
      }}
    >
      <TimelineToolbar {...props} totalFrames={totalFrames} clipCount={clipCount(document)} />

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <TrackHeaderColumn
          tracks={document.sequence.tracks}
          anySoloed={anySoloed}
          {...(props.onTrackMute !== undefined ? { onMute: props.onTrackMute } : {})}
          {...(props.onTrackSolo !== undefined ? { onSolo: props.onTrackSolo } : {})}
          {...(props.onTrackLock !== undefined ? { onLock: props.onTrackLock } : {})}
        />

        <div
          ref={laneAreaRef}
          onWheel={handleWheel}
          style={{
            flex: 1,
            position: 'relative',
            minWidth: 0,
            overflow: 'hidden',
            background: token.bgCanvas,
          }}
        >
          <TimelineRuler
            ticks={ticks}
            viewport={viewport}
            markers={document.sequence.markers}
            {...(document.sequence.workRange !== undefined ? { workRange: document.sequence.workRange } : {})}
            onPointerDown={handleRulerPointerDown}
            {...(props.onScrub !== undefined ? { onSeek: props.onScrub } : {})}
          />

          <div style={{ position: 'relative' }}>
            {document.sequence.tracks.map((track) => (
              <TrackLane
                key={track.id}
                track={track}
                viewport={viewport}
                selectedClips={props.selectedClips}
                {...(props.strips !== undefined ? { strips: props.strips } : {})}
                {...(props.onClipPointerDown !== undefined
                  ? { onClipPointerDown: props.onClipPointerDown }
                  : {})}
                {...(props.onSelectClip !== undefined ? { onSelectClip: props.onSelectClip } : {})}
                {...(props.onTrimStart !== undefined ? { onTrimStart: props.onTrimStart } : {})}
                {...(props.onTrimEnd !== undefined ? { onTrimEnd: props.onTrimEnd } : {})}
              />
            ))}
          </div>

          <Playhead px={frameToPx(viewport, playhead)} />
        </div>
      </div>
    </section>
  );
}

function TimelineToolbar({
  snapEnabled,
  rippleEnabled,
  viewport,
  totalFrames,
  clipCount: clips,
  document,
  onToggleSnap,
  onToggleRipple,
  onAddTrack,
  onMarkIn,
  onMarkOut,
  onClearRange,
}: TimelineProps & { readonly totalFrames: number; readonly clipCount: number }): ReactNode {
  const range = document.sequence.workRange;

  return (
    <div
      style={{
        height: token.panelHeaderHeight,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: token.space2,
        padding: `0 ${token.space5}`,
        borderBottom: `1px solid ${token.borderSubtle}`,
      }}
    >
      <Button
        tone={snapEnabled ? 'active' : 'default'}
        onClick={onToggleSnap}
        style={{ height: token.controlHeightSm }}
      >
        {snapEnabled && <StatusDot color={token.accent} size={6} />}
        Snap
      </Button>
      <Button
        tone={rippleEnabled ? 'active' : 'default'}
        onClick={onToggleRipple}
        style={{ height: token.controlHeightSm }}
      >
        Ripple
      </Button>

      {(onMarkIn ?? onMarkOut) !== undefined && (
        <>
          <Divider />
          {/* Named for what they mark, not for the keys that trigger them: the shortcut is on the
              title, where it teaches without taking width from a toolbar the mockups keep dense. */}
          <Button onClick={onMarkIn} title="Mark in (I)" style={{ height: token.controlHeightSm }}>
            Mark in
          </Button>
          <Button onClick={onMarkOut} title="Mark out (O)" style={{ height: token.controlHeightSm }}>
            Mark out
          </Button>
          {range !== undefined && (
            <>
              {/* The range is stated, not just drawn. A four-pixel bar on the ruler is easy to miss,
                  and an export that silently covers part of the sequence is the failure that costs
                  the most to discover afterwards. */}
              <Mono tone={token.accent}>
                {range.start}–{endExclusive(range) - 1}
              </Mono>
              <Button
                onClick={onClearRange}
                title="Clear the in/out range (Alt+X)"
                style={{ height: token.controlHeightSm }}
              >
                Clear
              </Button>
            </>
          )}
        </>
      )}

      <Divider />

      <Mono tone={token.textDim}>zoom</Mono>
      <Mono tone={token.textDim}>{formatZoom(viewport)}</Mono>

      <div style={{ flex: 1 }} />

      <Mono tone={token.textFaint}>{formatTimelineStatus(document.frameRate, totalFrames, clips)}</Mono>
      <Button onClick={onAddTrack} style={{ height: token.controlHeightSm }}>
        + Track
      </Button>
    </div>
  );
}

function TrackHeaderColumn({
  tracks,
  anySoloed,
  onMute,
  onSolo,
  onLock,
}: {
  readonly tracks: readonly Track[];
  readonly anySoloed: boolean;
  readonly onMute?: (track: TrackId) => void;
  readonly onSolo?: (track: TrackId) => void;
  readonly onLock?: (track: TrackId) => void;
}): ReactNode {
  return (
    <div
      style={{
        width: token.trackHeaderWidth,
        flex: 'none',
        background: token.bgPanel,
        borderRight: `1px solid ${token.border}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Spacer aligning the headers with the lanes, which sit below the ruler. */}
      <div
        style={{ height: token.rulerHeight, flex: 'none', borderBottom: `1px solid ${token.borderSubtle}` }}
      />

      {tracks.map((track) => (
        <TrackHeader
          key={track.id}
          track={track}
          audible={isTrackAudible(track, anySoloed)}
          {...(onMute !== undefined ? { onMute } : {})}
          {...(onSolo !== undefined ? { onSolo } : {})}
          {...(onLock !== undefined ? { onLock } : {})}
        />
      ))}
    </div>
  );
}

/**
 * Height below which a header lays its label and toggles out side by side.
 *
 * Stacked, the content needs label (13) + gap (6) + toggles (15) + padding (12) = 46 px, so a 46 px
 * text track has nothing to spare and clips its label. Track heights are persisted and user-resizable,
 * so this adapts rather than assuming the default heights fit.
 */
const STACKED_HEADER_MIN_HEIGHT = 52;

function TrackHeader({
  track,
  audible,
  onMute,
  onSolo,
  onLock,
}: {
  readonly track: Track;
  readonly audible: boolean;
  readonly onMute?: (track: TrackId) => void;
  readonly onSolo?: (track: TrackId) => void;
  readonly onLock?: (track: TrackId) => void;
}): ReactNode {
  const stacked = track.height >= STACKED_HEADER_MIN_HEIGHT;

  return (
    <div
      data-track-header={track.id}
      style={{
        height: track.height,
        flex: 'none',
        borderBottom: `1px solid ${token.borderSubtle}`,
        padding: `${token.space2} ${token.space4}`,
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'stretch' : 'center',
        justifyContent: 'center',
        gap: stacked ? token.space2 : token.space3,
        background: audible ? 'transparent' : token.trackActive,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          font: `600 11px ${token.fontUi}`,
          color: trackLabelColor(track),
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: stacked ? 'none' : 1,
          minWidth: 0,
        }}
      >
        {track.name}
      </span>
      <div style={{ display: 'flex', gap: token.space1, flex: 'none' }}>
        <TrackToggle
          label="M"
          active={track.muted}
          title={`Mute ${track.name}`}
          onClick={() => onMute?.(track.id)}
        />
        <TrackToggle
          label="S"
          active={track.solo}
          title={`Solo ${track.name}`}
          onClick={() => onSolo?.(track.id)}
        />
        <TrackToggle
          label="L"
          active={track.locked}
          title={`Lock ${track.name}`}
          onClick={() => onLock?.(track.id)}
        />
      </div>
    </div>
  );
}

function trackLabelColor(track: Track): string {
  switch (track.kind) {
    case 'audio':
      return token.okText;
    case 'text':
      return token.warnText;
    default:
      return token.textBright;
  }
}

/**
 * M/S/L toggle.
 *
 * A real button with `aria-pressed`: these states are otherwise conveyed only by a tint, which is
 * invisible to a screen reader and hard to read for low-contrast vision.
 */
function TrackToggle({
  label,
  active,
  title,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly title: string;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      style={{
        width: 17,
        height: 15,
        borderRadius: token.radiusInset,
        background: active ? '#1c2333' : token.surface2,
        border: `1px solid ${active ? '#2f4a72' : token.borderControl}`,
        color: active ? '#9dc2ff' : token.textSoft,
        font: `400 8.5px ${token.fontUi}`,
        lineHeight: '13px',
        padding: 0,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function TimelineRuler({
  ticks,
  viewport,
  markers,
  workRange,
  onPointerDown,
  onSeek,
}: {
  readonly ticks: readonly RulerTick[];
  readonly viewport: TimelineViewport;
  readonly markers: readonly Marker[];
  readonly workRange?: FrameSpan;
  readonly onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onSeek?: (frame: FrameIndex) => void;
}): ReactNode {
  const range = workRange === undefined ? undefined : spanGeometry(viewport, workRange);

  return (
    <div
      role="slider"
      aria-label="Playhead position"
      aria-valuemin={0}
      tabIndex={0}
      onPointerDown={onPointerDown}
      style={{
        height: token.rulerHeight,
        position: 'relative',
        borderBottom: `1px solid ${token.borderSubtle}`,
        background: token.bgPanel,
        cursor: 'text',
        overflow: 'hidden',
      }}
    >
      {range !== undefined && (
        <div
          data-work-range="true"
          aria-hidden="true"
          title="In/out range"
          style={{
            position: 'absolute',
            left: range.leftPx,
            width: range.widthPx,
            top: 0,
            height: 4,
            background: token.accent,
            pointerEvents: 'none',
          }}
        />
      )}
      {ticks.map((tick) => (
        <div
          key={tick.frame}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: tick.px,
            bottom: 0,
            width: 1,
            height: tick.major ? 9 : 5,
            background: tick.major ? '#454c58' : '#2f343d',
          }}
        />
      ))}
      {ticks
        .filter((tick) => tick.label !== undefined)
        .map((tick) => (
          <div
            key={`label-${tick.frame}`}
            style={{
              position: 'absolute',
              left: tick.px + 4,
              top: 5,
              font: token.textMeta,
              color: token.textDim,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {tick.label}
          </div>
        ))}

      {/* Markers last, so a flag is never hidden behind a tick label it happens to share a pixel
          with. They seek rather than select: a marker is a place, and the only thing to do with a
          place is go to it. */}
      {markers.map((marker) => (
        <button
          key={marker.frame}
          type="button"
          data-marker-frame={marker.frame}
          title={marker.label}
          aria-label={`Marker ${marker.label} at frame ${marker.frame}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onSeek?.(marker.frame)}
          style={{
            position: 'absolute',
            left: frameToPx(viewport, marker.frame) - 3,
            bottom: 0,
            width: 7,
            height: 9,
            padding: 0,
            border: 'none',
            borderRadius: '1px 1px 0 0',
            background: marker.color ?? token.warn,
            cursor: 'pointer',
          }}
        />
      ))}
    </div>
  );
}

function TrackLane({
  track,
  viewport,
  selectedClips,
  strips,
  onClipPointerDown,
  onSelectClip,
  onTrimStart,
  onTrimEnd,
}: {
  readonly track: Track;
  readonly viewport: TimelineViewport;
  readonly selectedClips: ReadonlySet<string>;
  readonly strips?: ReadonlyMap<string, ClipStrip>;
  readonly onClipPointerDown?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onSelectClip?: (clip: ClipId, additive: boolean) => void;
  readonly onTrimStart?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onTrimEnd?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
}): ReactNode {
  // Off-screen clips are skipped entirely. With the spec's 200-clip target this is not yet critical,
  // but it keeps the DOM proportional to what is visible rather than to project length.
  const visible = trackClips(track).filter((clip) => isSpanVisible(viewport, clip.span));

  return (
    <div
      data-track-id={track.id}
      data-track-kind={track.kind}
      style={{
        height: track.height,
        position: 'relative',
        borderBottom: `1px solid ${token.borderSubtle}`,
        background: track.kind === 'video' ? 'rgba(76, 154, 255, 0.02)' : 'transparent',
        boxSizing: 'border-box',
      }}
    >
      {visible.map((clip) => (
        <ClipBody
          key={clip.id}
          clip={clip}
          geometry={spanGeometry(viewport, clip.span)}
          heightPx={track.height}
          selected={selectedClips.has(clip.id)}
          {...(strips?.get(clip.id) !== undefined ? { strip: strips.get(clip.id)! } : {})}
          onPointerDown={(clipId, event) => {
            onSelectClip?.(clipId, event.shiftKey || event.metaKey);
            onClipPointerDown?.(clipId, event);
          }}
          {...(onTrimStart !== undefined ? { onTrimStart } : {})}
          {...(onTrimEnd !== undefined ? { onTrimEnd } : {})}
        />
      ))}
    </div>
  );
}

/**
 * The playhead.
 *
 * Spans every lane and sits above them. Hidden rather than clamped when scrolled out of view: a
 * playhead pinned to an edge would read as "the playhead is here", which is worse than absent.
 */
function Playhead({ px }: { readonly px: number }): ReactNode {
  if (px < -1) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: px,
        top: 0,
        bottom: 0,
        width: 1,
        background: token.accent,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: -6,
          top: 0,
          width: 13,
          height: 13,
          background: token.accent,
          clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
        }}
      />
    </div>
  );
}

/** Total occupied frames, exported so a caller can size a scrollbar. */
export function timelineExtent(document: TimelineDocument): FrameIndex {
  let end = 0;
  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      const clipEnd = endExclusive(clip.span);
      if (clipEnd > end) end = clipEnd;
    }
  }
  return frameIndex(end);
}

export type { Clip };
