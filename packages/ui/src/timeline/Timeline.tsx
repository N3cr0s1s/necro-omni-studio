import {
  Fragment,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type Clip,
  type ClipId,
  type FrameIndex,
  type FrameSpan,
  type Marker,
  type TimelineDocument,
  type SelectionRegion,
  type Track,
  type TrackId,
  type TrackKind,
  clipCount,
  documentEnd,
  endExclusive,
  frameIndex,
  isTrackAudible,
  spanFromBounds,
  trackClips,
} from '@nos/core';
import { ASSET_DRAG_TYPE } from '../media-browser/MediaBrowser.js';
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
  /**
   * A rectangle dragged across empty timeline.
   *
   * Reported as a frame span and the tracks it crossed, never as pixels: which clips that touches is
   * a question about the document, and the component has no business answering it.
   */
  readonly onSelectRegion?: (region: SelectionRegion, additive: boolean) => void;
  readonly onClipPointerDown?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onTrimStart?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onTrimEnd?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onToggleSnap?: () => void;
  readonly onToggleRipple?: () => void;
  readonly onZoom?: (framesPerPixel: number, anchorPx: number) => void;
  /** Scrolls the view by a pixel delta. Without it the timeline cannot be moved at all. */
  readonly onScrollBy?: (deltaPx: number) => void;
  /** Frames the whole sequence, or the marked range when there is one. */
  readonly onFit?: () => void;
  /**
   * An asset dropped from the media browser.
   *
   * Reported with the track and frame it landed on, so material goes where it was put rather than
   * wherever the playhead happened to be — which is the whole reason to drag rather than double-click.
   */
  readonly onDropAsset?: (asset: string, track: TrackId, frame: FrameIndex) => void;
  readonly onTrackMute?: (track: TrackId) => void;
  readonly onTrackSolo?: (track: TrackId) => void;
  readonly onTrackLock?: (track: TrackId) => void;
  /** Removes a track and everything on it. Absent hides the control rather than showing a dead one. */
  readonly onTrackRemove?: (track: TrackId) => void;
  /** Renames a track. `A2 · music` is how an editor says which row holds what. */
  readonly onTrackRename?: (track: TrackId, name: string) => void;
  /** Adds a track of a kind. The toolbar offers one button per kind the spec allows N of. */
  readonly onAddTrack?: (kind: TrackKind) => void;

  /**
   * The opened clip, and what to draw beneath its track.
   *
   * The spec's §6.1 puts a clip's parameter lanes *under the clip*, which means under its track and
   * not at the bottom of the panel: a lane is read against the clip it belongs to, and one drawn
   * three tracks away is a lane the user has to correlate by eye. The content is injected so this
   * component stays presentational and learns nothing about keyframes.
   */
  readonly expandedClip?: ClipId;
  readonly lanes?: ReactNode;
  readonly onToggleExpandClip?: (clip: ClipId) => void;

  /** In/out marks. Absent handlers hide the controls rather than showing dead ones. */
  readonly onMarkIn?: () => void;
  readonly onMarkOut?: () => void;
  readonly onClearRange?: () => void;
  /** Removes the marked range from every unlocked track. Offered only while a range exists. */
  readonly onRemoveRange?: () => void;
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
      // Ctrl/Cmd + wheel is the near-universal zoom gesture.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const bounds = laneAreaRef.current?.getBoundingClientRect();
        const anchorPx = bounds === undefined ? 0 : event.clientX - bounds.left;
        const factor = event.deltaY > 0 ? 1.25 : 0.8;
        props.onZoom?.(viewport.framesPerPixel * factor, anchorPx);
        return;
      }

      // A trackpad reports horizontal intent in `deltaX`; a mouse wheel has none, so shift is the
      // conventional stand-in. Reading both means the gesture works on either device.
      const horizontal = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
      if (horizontal === 0 || props.onScrollBy === undefined) return;
      event.preventDefault();
      props.onScrollBy(horizontal);
    },
    [props, viewport.framesPerPixel],
  );

  const anySoloed = document.sequence.tracks.some((track) => track.solo);
  const marquee = useMarquee({
    viewport,
    laneAreaRef,
    tracks: document.sequence.tracks,
    ...(props.onSelectRegion !== undefined ? { onSelect: props.onSelectRegion } : {}),
  });

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
          {...(props.onTrackRemove !== undefined ? { onRemove: props.onTrackRemove } : {})}
          {...(props.onTrackRename !== undefined ? { onRename: props.onTrackRename } : {})}
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

          <div
            style={{ position: 'relative' }}
            onPointerDown={marquee.begin}
            onDragOver={(event) => {
              if (props.onDropAsset === undefined) return;
              if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
              // Preventing the default is what makes an element a drop target at all, and the effect
              // is what turns the cursor from "no" into "copy" while the pointer is over a track.
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(event) => {
              const asset = event.dataTransfer.getData(ASSET_DRAG_TYPE);
              if (props.onDropAsset === undefined || asset === '') return;
              event.preventDefault();

              const bounds = event.currentTarget.getBoundingClientRect();
              const target = assetDropTarget(document.sequence.tracks, viewport, {
                x: event.clientX - bounds.left,
                y: event.clientY - bounds.top,
              });
              if (target === undefined) return;
              props.onDropAsset(asset, target.track, target.frame);
            }}
          >
            {marquee.rect !== undefined && (
              <div
                data-marquee="true"
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: marquee.rect.left,
                  top: marquee.rect.top,
                  width: marquee.rect.width,
                  height: marquee.rect.height,
                  border: `1px solid ${token.accent}`,
                  background: 'rgba(76, 154, 255, 0.12)',
                  pointerEvents: 'none',
                  zIndex: 2,
                }}
              />
            )}
            {document.sequence.tracks.map((track) => (
              <Fragment key={track.id}>
                <TrackLane
                  track={track}
                  viewport={viewport}
                  selectedClips={props.selectedClips}
                  {...(props.strips !== undefined ? { strips: props.strips } : {})}
                  {...(props.expandedClip !== undefined ? { expandedClip: props.expandedClip } : {})}
                  {...(props.onToggleExpandClip !== undefined
                    ? { onToggleExpandClip: props.onToggleExpandClip }
                    : {})}
                  {...(props.onClipPointerDown !== undefined
                    ? { onClipPointerDown: props.onClipPointerDown }
                    : {})}
                  {...(props.onSelectClip !== undefined ? { onSelectClip: props.onSelectClip } : {})}
                  {...(props.onTrimStart !== undefined ? { onTrimStart: props.onTrimStart } : {})}
                  {...(props.onTrimEnd !== undefined ? { onTrimEnd: props.onTrimEnd } : {})}
                />
                {props.lanes !== undefined && holdsClip(track, props.expandedClip) && (
                  <div data-clip-lanes={props.expandedClip} style={{ position: 'relative' }}>
                    {props.lanes}
                  </div>
                )}
              </Fragment>
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
  onFit,
  onAddTrack,
  onMarkIn,
  onMarkOut,
  onClearRange,
  onRemoveRange,
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
        // A mode, not a verb: it changes what Delete does, and saying so on the control is the
        // difference between a toggle a user trusts and one they experiment with.
        title={
          rippleEnabled
            ? 'Ripple on: deleting closes the gap, pulling the rest of the track back'
            : 'Ripple off: deleting leaves a gap, so everything downstream keeps its timing'
        }
        aria-pressed={rippleEnabled}
        style={{ height: token.controlHeightSm }}
      >
        {rippleEnabled && <StatusDot color={token.accent} size={6} />}
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
              {onRemoveRange !== undefined && (
                <Button
                  onClick={onRemoveRange}
                  title="Remove the marked range from every unlocked track and close the gaps"
                  style={{ height: token.controlHeightSm }}
                >
                  Cut range
                </Button>
              )}
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
      {onFit !== undefined && (
        <Button
          onClick={onFit}
          title="Fit the sequence — or the marked range — to the window (F)"
          style={{ height: token.controlHeightSm }}
        >
          Fit
        </Button>
      )}

      <div style={{ flex: 1 }} />

      <Mono tone={token.textFaint}>{formatTimelineStatus(document.frameRate, totalFrames, clips)}</Mono>
      {/* One button per kind rather than a single `+ Track` that guesses. The spec allows N of each,
          and which kind the user wants is not derivable from anything on screen. */}
      {onAddTrack !== undefined &&
        (['video', 'audio', 'text'] as const).map((kind) => (
          <Button
            key={kind}
            onClick={() => onAddTrack(kind)}
            title={`Add ${kind === 'audio' ? 'an' : 'a'} ${kind} track`}
            style={{ height: token.controlHeightSm }}
          >
            + {TRACK_BUTTON_LABEL[kind]}
          </Button>
        ))}
    </div>
  );
}

function TrackHeaderColumn({
  tracks,
  anySoloed,
  onMute,
  onSolo,
  onLock,
  onRemove,
  onRename,
}: {
  readonly tracks: readonly Track[];
  readonly anySoloed: boolean;
  readonly onMute?: (track: TrackId) => void;
  readonly onSolo?: (track: TrackId) => void;
  readonly onLock?: (track: TrackId) => void;
  readonly onRemove?: (track: TrackId) => void;
  readonly onRename?: (track: TrackId, name: string) => void;
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
          {...(onRemove !== undefined ? { onRemove } : {})}
          {...(onRename !== undefined ? { onRename } : {})}
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
  onRemove,
  onRename,
}: {
  readonly track: Track;
  readonly audible: boolean;
  readonly onMute?: (track: TrackId) => void;
  readonly onSolo?: (track: TrackId) => void;
  readonly onLock?: (track: TrackId) => void;
  readonly onRemove?: (track: TrackId) => void;
  readonly onRename?: (track: TrackId, name: string) => void;
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
      <EditableName
        value={track.name}
        tone={trackLabelColor(track)}
        title={`${track.name} — double-click to rename`}
        style={{ flex: stacked ? 'none' : 1 }}
        {...(onRename !== undefined ? { onCommit: (name: string) => onRename(track.id, name) } : {})}
      />
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
        {/* Removal sits with the toggles rather than behind a menu, and is *disabled* on a locked
            track rather than hidden: a control that vanishes leaves the user hunting for it, where a
            disabled one with a reason explains itself. */}
        {onRemove !== undefined && (
          <TrackToggle
            label="×"
            active={false}
            disabled={track.locked}
            title={
              track.locked
                ? `${track.name} is locked — unlock it to remove it`
                : `Remove ${track.name} and everything on it`
            }
            onClick={() => onRemove(track.id)}
          />
        )}
      </div>
    </div>
  );
}

interface MarqueeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The rubber-band selection.
 *
 * Starts only on the lane background: a pointer-down that lands on a clip is a move gesture, and a
 * marquee that also began there would make every drag ambiguous. The rectangle is drawn in pixels
 * because that is what the user is dragging, and reported in frames and tracks because that is what
 * the document understands.
 */
function useMarquee(options: {
  readonly viewport: TimelineViewport;
  readonly laneAreaRef: React.RefObject<HTMLDivElement | null>;
  readonly tracks: readonly Track[];
  readonly onSelect?: (region: SelectionRegion, additive: boolean) => void;
}): { readonly rect: MarqueeRect | undefined; begin: (event: React.PointerEvent<HTMLElement>) => void } {
  const [rect, setRect] = useState<MarqueeRect | undefined>(undefined);
  const origin = useRef<{ x: number; y: number; additive: boolean } | undefined>(undefined);

  const latest = useRef(options);
  latest.current = options;

  const begin = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Only the background. A clip stops its own pointer-down from reaching here by being handled
    // first, so this fires exactly when the user grabbed nothing.
    if (event.target !== event.currentTarget) return;
    // Anything but the primary button belongs to a context menu. Written as "not zero when stated"
    // rather than "is zero", because a synthetic pointer event does not always carry one and a
    // missing button is not a right-click.
    if ((event.button ?? 0) !== 0) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    origin.current = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      additive: event.shiftKey || event.metaKey,
    };
    setRect({ left: origin.current.x, top: origin.current.y, width: 0, height: 0 });
  }, []);

  useEffect(() => {
    if (rect === undefined) return;

    function onMove(event: PointerEvent): void {
      const start = origin.current;
      const area = latest.current.laneAreaRef.current;
      if (start === undefined || area === null) return;

      const bounds = area.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top - rulerHeightPx(area);
      setRect({
        left: Math.min(start.x, x),
        top: Math.min(start.y, y),
        width: Math.abs(x - start.x),
        height: Math.abs(y - start.y),
      });
    }

    function onUp(): void {
      const start = origin.current;
      origin.current = undefined;

      setRect((current) => {
        if (current !== undefined && start !== undefined && current.width + current.height > 3) {
          // A rectangle smaller than a few pixels is a click, not a drag, and reporting it would
          // clear the selection every time a user tapped the background to focus the timeline.
          const { viewport, tracks, onSelect } = latest.current;
          onSelect?.(regionFor(viewport, tracks, current), start.additive);
        }
        return undefined;
      });
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [rect]);

  return { rect, begin };
}

/**
 * Where a drop lands.
 *
 * Exported and pure, so the decision can be tested directly: jsdom has no `DragEvent`, which makes a
 * drop impossible to dispatch at a React handler there. The three lines left in the component read
 * the payload and call this.
 *
 * The frame is floored and clamped at zero — dropping left of the timeline's start means the start,
 * which is the only position there is, and refusing instead would make a near miss feel broken.
 */
export function assetDropTarget(
  tracks: readonly Track[],
  viewport: TimelineViewport,
  offset: { readonly x: number; readonly y: number },
): { readonly track: TrackId; readonly frame: FrameIndex } | undefined {
  let top = 0;
  for (const track of tracks) {
    top += track.height;
    if (offset.y < top) {
      return { track: track.id, frame: frameIndex(Math.max(0, pxToFrameFloor(viewport, offset.x))) };
    }
  }
  // Below the last track: nothing to drop onto, and guessing the nearest would put material on a row
  // the user was not pointing at.
  return undefined;
}

/** The lane area's own ruler offset, so a rectangle's top is measured from the first track. */
function rulerHeightPx(area: HTMLElement): number {
  const ruler = area.querySelector('[role="slider"]');
  return ruler === null ? 0 : ruler.getBoundingClientRect().height;
}

/**
 * Converts a pixel rectangle into the frames and tracks it covers.
 *
 * Exported so the geometry can be tested directly: jsdom gives every element a zero-sized box and
 * drops the coordinates from a synthetic pointer event, so a test driving the gesture can assert
 * that a rectangle *appears* but not where it landed. The arithmetic is the part worth pinning down.
 */
export function regionFor(
  viewport: TimelineViewport,
  tracks: readonly Track[],
  rect: MarqueeRect,
): SelectionRegion {
  const from = pxToFrameFloor(viewport, rect.left);
  const to = pxToFrameFloor(viewport, rect.left + rect.width);

  const covered: TrackId[] = [];
  let offset = 0;
  for (const track of tracks) {
    const top = offset;
    offset += track.height;
    if (top < rect.top + rect.height && offset > rect.top) covered.push(track.id);
  }

  return {
    span: spanFromBounds(frameIndex(Math.max(0, from)), frameIndex(Math.max(1, to + 1))),
    tracks: covered,
  };
}

/**
 * A label that becomes a field on double-click.
 *
 * Double-click rather than a pencil button: the header is already dense with M/S/L and a remove
 * control, and renaming is rare enough that it does not deserve permanent width. Escape abandons the
 * edit and Enter commits it, which is what every inline rename anywhere does — a field that could
 * only be left by clicking elsewhere would leave the user unsure whether their change took.
 */
function EditableName({
  value,
  tone,
  title,
  style,
  onCommit,
}: {
  readonly value: string;
  readonly tone: string;
  readonly title: string;
  readonly style?: CSSProperties;
  readonly onCommit?: (name: string) => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing || onCommit === undefined) {
    return (
      <span
        title={onCommit === undefined ? value : title}
        onDoubleClick={() => {
          if (onCommit === undefined) return;
          setDraft(value);
          setEditing(true);
        }}
        style={{
          font: `600 11px ${token.fontUi}`,
          color: tone,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
          ...style,
        }}
      >
        {value}
      </span>
    );
  }

  const finish = (commit: boolean): void => {
    setEditing(false);
    if (commit) onCommit(draft);
  };

  return (
    <input
      // Focused on appearing: the field exists only because the user just asked for it, and anything
      // else would need a second click before they could type.
      autoFocus
      aria-label={`Rename ${value}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
        else return;
        event.preventDefault();
      }}
      style={{
        font: `600 11px ${token.fontUi}`,
        color: token.textBright,
        background: token.surface1,
        border: `1px solid ${token.accent}`,
        borderRadius: token.radiusInset,
        padding: '1px 3px',
        minWidth: 0,
        width: '100%',
        ...style,
      }}
    />
  );
}

/** Short enough for a dense toolbar, and the letters already on every track header. */
const TRACK_BUTTON_LABEL: Readonly<Record<TrackKind, string>> = { video: 'V', audio: 'A', text: 'T' };

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
  disabled = false,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly title: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
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

/** Whether a track holds a clip, which decides where the opened clip's lanes are drawn. */
function holdsClip(track: Track, clip: ClipId | undefined): boolean {
  return clip !== undefined && trackClips(track).some((candidate) => candidate.id === clip);
}

function TrackLane({
  track,
  viewport,
  selectedClips,
  strips,
  expandedClip,
  onToggleExpandClip,
  onClipPointerDown,
  onSelectClip,
  onTrimStart,
  onTrimEnd,
}: {
  readonly track: Track;
  readonly viewport: TimelineViewport;
  readonly selectedClips: ReadonlySet<string>;
  readonly strips?: ReadonlyMap<string, ClipStrip>;
  readonly expandedClip?: ClipId;
  readonly onToggleExpandClip?: (clip: ClipId) => void;
  readonly onClipPointerDown?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onSelectClip?: (clip: ClipId, additive: boolean) => void;
  /**
   * A rectangle dragged across empty timeline.
   *
   * Reported as a frame span and the tracks it crossed, never as pixels: which clips that touches is
   * a question about the document, and the component has no business answering it.
   */
  readonly onSelectRegion?: (region: SelectionRegion, additive: boolean) => void;
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
          expanded={expandedClip === clip.id}
          {...(onToggleExpandClip !== undefined ? { onToggleExpand: onToggleExpandClip } : {})}
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
