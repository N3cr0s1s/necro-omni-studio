import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  ArrowRightLeftIcon,
  AudioLinesIcon,
  FilmIcon,
  HeadphonesIcon,
  LockIcon,
  LogInIcon,
  LogOutIcon,
  MagnetIcon,
  MaximizeIcon,
  ScissorsIcon,
  Trash2Icon,
  TypeIcon,
  VolumeXIcon,
} from 'lucide-react';
import { Button } from '@nos/ui/components/ui/button';
import { Input } from '@nos/ui/components/ui/input';
import { Separator } from '@nos/ui/components/ui/separator';
import { Toggle } from '@nos/ui/components/ui/toggle';
import { cn } from '@nos/ui/lib/utils';
import { ASSET_DRAG_TYPE } from '../media-browser/MediaBrowser.js';
import { type MenuBinding, ActionMenu } from '../menus/ActionMenu.js';
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

/**
 * What a right-click on the timeline was on.
 *
 * A value rather than two callbacks, because the answer is one of a small set and the menu's contents
 * depend on *which*: a click on a clip offers clip actions, a click on a lane offers track actions,
 * and a click on the empty area below the last track offers only what applies to no target at all.
 * Both fields absent is that last case, and is meaningful rather than an omission.
 */
export interface TimelineMenuTarget {
  readonly clip?: ClipId;
  readonly track?: TrackId;
}

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
   * The right-click menu, for a clip, a lane, or the empty area below the last track.
   *
   * *What the menu offers* is the shell's business, because the answer depends on the selection, the
   * clipboard and the history — none of which this component knows about. All this decides is which
   * target a click was about.
   */
  readonly menu?: MenuBinding<TimelineMenuTarget>;
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
  /**
   * A track whose name field should be open.
   *
   * Driven from outside because the rename can be asked for from the context menu as well as by
   * double-clicking the name, and two ways of renaming that behaved differently would be worse than
   * one. The caller clears it when the edit finishes.
   */
  readonly renamingTrack?: TrackId;
  /**
   * The frame a drag is currently snapped to, and what it caught.
   *
   * Drawn because snapping is otherwise indistinguishable from the clip refusing to follow the
   * pointer — a user who cannot see what it caught learns to distrust it and turns it off.
   */
  readonly snapIndicator?: { readonly frame: FrameIndex; readonly kind: string };
  readonly onTrackMute?: (track: TrackId) => void;
  readonly onTrackSolo?: (track: TrackId) => void;
  readonly onTrackLock?: (track: TrackId) => void;
  /** Removes a track and everything on it. Absent hides the control rather than showing a dead one. */
  readonly onTrackRemove?: (track: TrackId) => void;
  /** Renames a track. `A2 · music` is how an editor says which row holds what. */
  readonly onTrackRename?: (track: TrackId, name: string) => void;
  /**
   * Resizes a track, by dragging the bottom edge of its header.
   *
   * `phase` is what lets a whole drag become one undo step: the shell opens a gesture on the first
   * move and closes it on `end`, the same rule every other drag in this application follows.
   */
  readonly onTrackResize?: (track: TrackId, height: number, phase: 'move' | 'end') => void;
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

/** The empty area below the last track: a right-click there is about no clip and no lane. */
const NO_TARGET: TimelineMenuTarget = {};

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

  // Where a dragged asset would land, so letting go is not a guess.
  const [dropTarget, setDropTarget] = useState<
    { readonly track: TrackId; readonly frame: FrameIndex } | undefined
  >(undefined);

  const anySoloed = document.sequence.tracks.some((track) => track.solo);
  const marquee = useMarquee({
    viewport,
    tracks: document.sequence.tracks,
    ...(props.onSelectRegion !== undefined ? { onSelect: props.onSelectRegion } : {}),
  });

  return (
    <section aria-label="Timeline" className="flex h-98 min-h-0 flex-none flex-col border-t">
      <TimelineToolbar {...props} totalFrames={totalFrames} clipCount={clipCount(document)} />

      {/*
        One scroller holding the headers, the ruler and the lanes, with the ruler *sticky* rather than
        lifted into a row of its own.

        The lifted version drifted horizontally: once the tracks overflowed, the scroller gave up a
        scrollbar's width and the ruler's separate row did not, so the ticks stopped lining up with
        the clips beneath them. Making the ruler part of the very column it measures removes the
        possibility instead of compensating for it — there is one width now, and nothing to keep in
        sync. Headers and lanes scroll as one element for the same reason vertically.
      */}
      <div className="flex min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <TrackHeaderColumn
          tracks={document.sequence.tracks}
          anySoloed={anySoloed}
          {...(props.onTrackMute !== undefined ? { onMute: props.onTrackMute } : {})}
          {...(props.onTrackSolo !== undefined ? { onSolo: props.onTrackSolo } : {})}
          {...(props.onTrackLock !== undefined ? { onLock: props.onTrackLock } : {})}
          {...(props.onTrackRemove !== undefined ? { onRemove: props.onTrackRemove } : {})}
          {...(props.onTrackRename !== undefined ? { onRename: props.onTrackRename } : {})}
          {...(props.onTrackResize !== undefined ? { onResize: props.onTrackResize } : {})}
          {...(props.renamingTrack !== undefined ? { renaming: props.renamingTrack } : {})}
        />

        <div
          ref={laneAreaRef}
          data-lane-column=""
          onWheel={handleWheel}
          className="relative min-w-0 flex-1 bg-muted/30"
        >
          {/* Sticky, so it stays visible while the tracks scroll under it and still belongs to the
              column whose pixels it measures. */}
          <div className="sticky top-0 z-4">
            <TimelineRuler
              ticks={ticks}
              viewport={viewport}
              markers={document.sequence.markers}
              {...(document.sequence.workRange !== undefined
                ? { workRange: document.sequence.workRange }
                : {})}
              onPointerDown={handleRulerPointerDown}
              {...(props.onScrub !== undefined ? { onSeek: props.onScrub } : {})}
            />
          </div>

          {/*
            The menu for the area below the last track. Nested inside it are one trigger per lane and
            one per clip, and Base UI hands a right-click to the innermost — which is what makes
            "a click on a clip is about the clip, not about the lane it sits on" structural rather than
            a target check somebody has to remember to write.
          */}
          <ActionMenu
            items={props.menu === undefined ? [] : props.menu.items(NO_TARGET)}
            onChoose={(action) => props.menu?.onChoose(NO_TARGET, action)}
          >
            <div
              data-lane-surface=""
              className="relative"
              onPointerDown={marquee.begin}
              onDragOver={(event) => {
                if (props.onDropAsset === undefined) return;
                if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
                // Preventing the default is what makes an element a drop target at all, and the effect
                // is what turns the cursor from "no" into "copy" while the pointer is over a track.
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';

                // Where it *would* land, computed from the same function the drop uses so the two
                // cannot disagree. Without this a drop was a guess: the user let go and found out,
                // which is what "not deterministic" meant.
                const bounds = event.currentTarget.getBoundingClientRect();
                setDropTarget(
                  assetDropTarget(document.sequence.tracks, viewport, {
                    x: event.clientX - bounds.left,
                    y: event.clientY - bounds.top,
                  }),
                );
              }}
              onDragLeave={(event) => {
                // Only when the pointer leaves the lane area itself. `dragleave` fires for every child
                // it crosses, and clearing on those would make the indicator flicker as it moves.
                if (event.target !== event.currentTarget) return;
                setDropTarget(undefined);
              }}
              onDrop={(event) => {
                const asset = event.dataTransfer.getData(ASSET_DRAG_TYPE);
                setDropTarget(undefined);
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
                  className="pointer-events-none absolute z-2 border border-primary bg-primary/10"
                  style={{
                    left: marquee.rect.left,
                    top: marquee.rect.top,
                    width: marquee.rect.width,
                    height: marquee.rect.height,
                  }}
                />
              )}
              {document.sequence.tracks.map((track) => (
                <Fragment key={track.id}>
                  <TrackLane
                    track={track}
                    viewport={viewport}
                    {...(dropTarget?.track === track.id ? { dropAt: dropTarget.frame } : {})}
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
                    {...(props.menu !== undefined ? { menu: props.menu } : {})}
                    {...(props.onTrimStart !== undefined ? { onTrimStart: props.onTrimStart } : {})}
                    {...(props.onTrimEnd !== undefined ? { onTrimEnd: props.onTrimEnd } : {})}
                  />
                  {props.lanes !== undefined && holdsClip(track, props.expandedClip) && (
                    <div data-clip-lanes={props.expandedClip} className="relative">
                      {props.lanes}
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          </ActionMenu>

          {props.snapIndicator !== undefined && (
            <SnapLine px={frameToPx(viewport, props.snapIndicator.frame)} kind={props.snapIndicator.kind} />
          )}

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
    <div className="flex h-8.5 flex-none items-center gap-2 border-b px-4">
      <Toggle size="sm" pressed={snapEnabled} onPressedChange={() => onToggleSnap?.()} title="Snap (N)">
        <MagnetIcon />
        Snap
      </Toggle>
      <Toggle
        size="sm"
        pressed={rippleEnabled}
        onPressedChange={() => onToggleRipple?.()}
        // A mode, not a verb: it changes what Delete does, and saying so on the control is the
        // difference between a toggle a user trusts and one they experiment with.
        title={
          rippleEnabled
            ? 'Ripple on: deleting closes the gap, pulling the rest of the track back'
            : 'Ripple off: deleting leaves a gap, so everything downstream keeps its timing'
        }
      >
        <ArrowRightLeftIcon />
        Ripple
      </Toggle>

      {(onMarkIn ?? onMarkOut) !== undefined && (
        <>
          <Separator orientation="vertical" className="h-4" />
          {/* Named for what they mark, not for the keys that trigger them: the shortcut is on the
              title, where it teaches without taking width from a toolbar the mockups keep dense. */}
          <Button variant="outline" size="sm" onClick={onMarkIn} title="Mark in (I)">
            <LogInIcon />
            Mark in
          </Button>
          <Button variant="outline" size="sm" onClick={onMarkOut} title="Mark out (O)">
            <LogOutIcon />
            Mark out
          </Button>
          {range !== undefined && (
            <>
              {/* The range is stated, not just drawn. A four-pixel bar on the ruler is easy to miss,
                  and an export that silently covers part of the sequence is the failure that costs
                  the most to discover afterwards. */}
              <span className="font-mono text-xs text-primary">
                {range.start}–{endExclusive(range) - 1}
              </span>
              {onRemoveRange !== undefined && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRemoveRange}
                  title="Remove the marked range from every unlocked track and close the gaps"
                >
                  <ScissorsIcon />
                  Cut range
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClearRange} title="Clear the in/out range (Alt+X)">
                Clear
              </Button>
            </>
          )}
        </>
      )}

      <Separator orientation="vertical" className="h-4" />

      <span className="font-mono text-xs text-muted-foreground">zoom</span>
      <span className="font-mono text-xs text-muted-foreground">{formatZoom(viewport)}</span>
      {onFit !== undefined && (
        <Button
          variant="outline"
          size="sm"
          onClick={onFit}
          title="Fit the sequence — or the marked range — to the window (F)"
        >
          <MaximizeIcon />
          Fit
        </Button>
      )}

      <span className="ml-auto font-mono text-xs text-muted-foreground">
        {formatTimelineStatus(document.frameRate, totalFrames, clips)}
      </span>
      {/* One button per kind rather than a single `+ Track` that guesses. The spec allows N of each,
          and which kind the user wants is not derivable from anything on screen. */}
      {onAddTrack !== undefined &&
        (['video', 'audio', 'text'] as const).map((kind) => {
          const Icon = TRACK_KIND_ICON[kind];
          return (
            <Button
              key={kind}
              variant="outline"
              size="icon-sm"
              onClick={() => onAddTrack(kind)}
              title={`Add ${kind === 'audio' ? 'an' : 'a'} ${kind} track`}
            >
              <Icon />
            </Button>
          );
        })}
    </div>
  );
}

function TrackHeaderColumn({
  tracks,
  anySoloed,
  renaming,
  onMute,
  onSolo,
  onLock,
  onRemove,
  onRename,
  onResize,
}: {
  readonly tracks: readonly Track[];
  readonly anySoloed: boolean;
  readonly renaming?: TrackId;
  readonly onMute?: (track: TrackId) => void;
  readonly onSolo?: (track: TrackId) => void;
  readonly onLock?: (track: TrackId) => void;
  readonly onRemove?: (track: TrackId) => void;
  readonly onRename?: (track: TrackId, name: string) => void;
  readonly onResize?: (track: TrackId, height: number, phase: 'move' | 'end') => void;
}): ReactNode {
  return (
    <div className="flex w-37 flex-none flex-col border-r">
      {/* Spacer aligning the headers with the lanes, which sit below the ruler. */}
      <div className="h-6.5 flex-none border-b" />

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
          {...(onResize !== undefined ? { onResize } : {})}
          renaming={renaming === track.id}
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
  onResize,
  renaming = false,
}: {
  readonly track: Track;
  readonly audible: boolean;
  /** True when a rename was asked for elsewhere, so the field opens without a double-click. */
  readonly renaming?: boolean;
  readonly onMute?: (track: TrackId) => void;
  readonly onSolo?: (track: TrackId) => void;
  readonly onLock?: (track: TrackId) => void;
  readonly onRemove?: (track: TrackId) => void;
  readonly onRename?: (track: TrackId, name: string) => void;
  readonly onResize?: (track: TrackId, height: number, phase: 'move' | 'end') => void;
}): ReactNode {
  const stacked = track.height >= STACKED_HEADER_MIN_HEIGHT;

  return (
    <div
      data-track-header={track.id}
      className={cn(
        'relative flex flex-none justify-center overflow-hidden border-b px-3 py-1',
        stacked ? 'flex-col items-stretch gap-2' : 'flex-row items-center gap-3',
        // A muted row for a track that is not being heard: silence is a state, and one that is
        // invisible gets blamed on the engine.
        !audible && 'bg-muted/60',
      )}
      style={{ height: track.height }}
    >
      {onResize !== undefined && <ResizeHandle track={track} onResize={onResize} />}
      <EditableName
        autoEdit={renaming}
        value={track.name}
        tone={trackLabelColor(track)}
        title={`${track.name} — double-click to rename`}
        className={stacked ? 'flex-none' : 'flex-1'}
        {...(onRename !== undefined ? { onCommit: (name: string) => onRename(track.id, name) } : {})}
      />
      <div className="flex flex-none gap-0.5">
        <TrackToggle
          icon={VolumeXIcon}
          active={track.muted}
          title={`Mute ${track.name}`}
          onClick={() => onMute?.(track.id)}
        />
        <TrackToggle
          icon={HeadphonesIcon}
          active={track.solo}
          title={`Solo ${track.name}`}
          onClick={() => onSolo?.(track.id)}
        />
        <TrackToggle
          icon={LockIcon}
          active={track.locked}
          title={`Lock ${track.name}`}
          onClick={() => onLock?.(track.id)}
        />
        {/* Removal sits with the toggles rather than behind a menu, and is *disabled* on a locked
            track rather than hidden: a control that vanishes leaves the user hunting for it, where a
            disabled one with a reason explains itself. */}
        {onRemove !== undefined && (
          <TrackToggle
            icon={Trash2Icon}
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
  readonly tracks: readonly Track[];
  readonly onSelect?: (region: SelectionRegion, additive: boolean) => void;
}): { readonly rect: MarqueeRect | undefined; begin: (event: React.PointerEvent<HTMLElement>) => void } {
  const [rect, setRect] = useState<MarqueeRect | undefined>(undefined);
  // The element the gesture started on, remembered rather than looked up: it is the lane container,
  // and measuring against anything else — the ruler's column, say — offsets every rectangle by the
  // height of whatever sits between them.
  const origin = useRef<{ x: number; y: number; additive: boolean; element: HTMLElement } | undefined>(
    undefined,
  );

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
      element: event.currentTarget,
    };
    setRect({ left: origin.current.x, top: origin.current.y, width: 0, height: 0 });
  }, []);

  useEffect(() => {
    if (rect === undefined) return;

    function onMove(event: PointerEvent): void {
      const start = origin.current;
      if (start === undefined) return;

      const bounds = start.element.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
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
 * The line a drag has snapped to.
 *
 * Named as well as drawn: "playhead" and "the end of that clip" are different reasons for a clip to
 * have jumped, and a bare line leaves the user to work out which. Dashed, so it is never mistaken for
 * the playhead it may be sitting exactly on top of.
 */
function SnapLine({ px, kind }: { readonly px: number; readonly kind: string }): ReactNode {
  return (
    <div
      data-snap-line={kind}
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-3 w-0 border-l border-dashed border-chart-3"
      style={{ left: px }}
    >
      <span className="absolute top-0.5 left-1 font-mono text-[9px] whitespace-nowrap text-chart-3">
        {kind.replace(/-/g, ' ')}
      </span>
    </div>
  );
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
 * The grip along a header's bottom edge.
 *
 * On the header rather than on the lane, because the lane is covered in clips whose own drags mean
 * something else entirely. Reported live rather than on release: a row that only resized when the
 * pointer came up would be adjusted by trial and error.
 */
function ResizeHandle({
  track,
  onResize,
}: {
  readonly track: Track;
  readonly onResize: (track: TrackId, height: number, phase: 'move' | 'end') => void;
}): ReactNode {
  const origin = useRef<{ y: number; height: number } | undefined>(undefined);

  return (
    <div
      role="separator"
      aria-label={`Resize ${track.name}`}
      aria-orientation="horizontal"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        origin.current = { y: event.clientY, height: track.height };
        // Best-effort: capture keeps the drag alive when the pointer leaves the five-pixel grip, but
        // an environment without it must still resize rather than throw.
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = origin.current;
        if (start === undefined) return;
        onResize(track.id, start.height + (event.clientY - start.y), 'move');
      }}
      onPointerUp={(event) => {
        const start = origin.current;
        origin.current = undefined;
        // Reported *before* releasing: a gesture that ended without saying so would leave the shell's
        // undo entry open for the rest of the session, swallowing every later edit into it.
        if (start !== undefined) onResize(track.id, start.height + (event.clientY - start.y), 'end');
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      // Invisible until pointed at: a permanent line on every header would read as a divider the
      // user is meant to notice, when it is only there for the moment they reach for it.
      className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize bg-transparent"
    />
  );
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
  className,
  autoEdit = false,
  onCommit,
}: {
  readonly value: string;
  /** A theme role as a Tailwind class, so a track kind is recognisable without being recoloured. */
  readonly tone: string;
  readonly title: string;
  readonly className?: string | undefined;
  /** Opens the field without a double-click, for a rename asked for somewhere else — a menu. */
  readonly autoEdit?: boolean;
  readonly onCommit?: (name: string) => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    // A rename chosen from the context menu has to land in the same field a double-click opens, or
    // there would be two ways to rename a track that behaved differently.
    if (!autoEdit) return;
    setDraft(value);
    setEditing(true);
  }, [autoEdit, value]);

  if (!editing || onCommit === undefined) {
    return (
      <span
        title={onCommit === undefined ? value : title}
        onDoubleClick={() => {
          if (onCommit === undefined) return;
          setDraft(value);
          setEditing(true);
        }}
        className={cn('min-w-0 truncate text-[11px] font-semibold', tone, className)}
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
    <Input
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
      className={cn('h-6 w-full min-w-0 px-1 py-0 text-[11px] font-semibold', className)}
    />
  );
}

/**
 * The glyph for a track kind.
 *
 * These used to be the letters `V`, `A` and `T` on the add-track buttons, which is compact and means
 * nothing until somebody explains it. The same three shapes now say it on the button and beside the
 * clips of that kind.
 */
const TRACK_KIND_ICON: Readonly<Record<TrackKind, typeof FilmIcon>> = {
  video: FilmIcon,
  audio: AudioLinesIcon,
  text: TypeIcon,
};

/**
 * The role a track's name is written in — the same one its clips are drawn in.
 *
 * A class rather than a colour, so the header follows the theme; and the same `chart` roles
 * `ClipBody` uses, so a row and the material on it are recognisably the same kind of thing.
 */
function trackLabelColor(track: Track): string {
  switch (track.kind) {
    case 'audio':
      return 'text-chart-2';
    case 'text':
      return 'text-chart-5';
    default:
      return 'text-chart-1';
  }
}

/**
 * M/S/L toggle.
 *
 * A real button with `aria-pressed`: these states are otherwise conveyed only by a tint, which is
 * invisible to a screen reader and hard to read for low-contrast vision.
 */
function TrackToggle({
  icon: Icon,
  active,
  title,
  disabled = false,
  onClick,
}: {
  readonly icon: typeof FilmIcon;
  readonly active: boolean;
  readonly title: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Toggle
      size="sm"
      title={title}
      aria-label={title}
      pressed={active}
      disabled={disabled}
      onPressedChange={onClick}
      className="size-4.5 min-w-0 p-0 [&_svg:not([class*='size-'])]:size-3"
    >
      <Icon />
    </Toggle>
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
      className="relative h-6.5 cursor-text overflow-hidden border-b bg-background"
    >
      {range !== undefined && (
        <div
          data-work-range="true"
          aria-hidden="true"
          title="In/out range"
          className="pointer-events-none absolute top-0 h-1 bg-primary"
          style={{ left: range.leftPx, width: range.widthPx }}
        />
      )}
      {ticks.map((tick) => (
        <div
          key={tick.frame}
          aria-hidden="true"
          className={cn('absolute bottom-0 w-px', tick.major ? 'h-2.5 bg-border' : 'h-1.5 bg-border/50')}
          style={{ left: tick.px }}
        />
      ))}
      {ticks
        .filter((tick) => tick.label !== undefined)
        .map((tick) => (
          <div
            key={`label-${tick.frame}`}
            className="pointer-events-none absolute top-1 font-mono text-[9px] whitespace-nowrap text-muted-foreground"
            style={{ left: tick.px + 4 }}
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
          // The colour is the marker's own — a user who set one chose it deliberately, and overriding
          // it with a theme role would throw away the only thing that tells two markers apart. Absent,
          // it falls back to a role.
          className={cn(
            'absolute bottom-0 h-2.5 w-2 cursor-pointer rounded-t-sm',
            marker.color === undefined && 'bg-chart-3',
          )}
          style={{
            left: frameToPx(viewport, marker.frame) - 3,
            ...(marker.color !== undefined ? { background: marker.color } : {}),
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
  menu,
  onTrimStart,
  onTrimEnd,
  dropAt,
}: {
  readonly track: Track;
  readonly viewport: TimelineViewport;
  /** Frame a dragged asset would land on, when this is the track it would land on. */
  readonly dropAt?: FrameIndex;
  readonly selectedClips: ReadonlySet<string>;
  readonly strips?: ReadonlyMap<string, ClipStrip>;
  readonly expandedClip?: ClipId;
  readonly onToggleExpandClip?: (clip: ClipId) => void;
  readonly onClipPointerDown?: (clip: ClipId, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onSelectClip?: (clip: ClipId, additive: boolean) => void;
  readonly menu?: MenuBinding<TimelineMenuTarget>;
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
  const target: TimelineMenuTarget = { track: track.id };

  return (
    <ActionMenu
      items={menu === undefined ? [] : menu.items(target)}
      onChoose={(action) => menu?.onChoose(target, action)}
    >
      <div
        data-track-id={track.id}
        data-track-kind={track.kind}
        className="relative border-b"
        style={{ height: track.height }}
      >
        {dropAt !== undefined && <DropIndicator viewport={viewport} frame={dropAt} height={track.height} />}

        {visible.map((clip) => (
          <ClipBody
            key={clip.id}
            clip={clip}
            rollableStart={flushBefore(track, clip)}
            rollableEnd={flushAfter(track, clip)}
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
            // Right-clicking an unselected clip selects it first, and leaves a multiple selection
            // alone — a menu opened over one of five selected clips is about all five.
            onContextMenu={(clipId) => {
              if (!selectedClips.has(clipId)) onSelectClip?.(clipId, false);
            }}
            {...(menu !== undefined
              ? {
                  menu: {
                    items: (clipId: ClipId) => menu.items({ clip: clipId, track: track.id }),
                    onChoose: (clipId: ClipId, action: string) =>
                      menu.onChoose({ clip: clipId, track: track.id }, action),
                  },
                }
              : {})}
            {...(onTrimStart !== undefined ? { onTrimStart } : {})}
            {...(onTrimEnd !== undefined ? { onTrimEnd } : {})}
          />
        ))}
      </div>
    </ActionMenu>
  );
}

/**
 * Whether a clip's head sits flush against the clip before it, and its tail against the one after.
 *
 * What makes an edge a *cut* rather than merely an end, and therefore what makes rolling it possible.
 * Exported so the rule has one definition: the handle's affordance and the edit itself have to agree
 * about which edges are cuts, or the tooltip promises a gesture that refuses.
 */
export function flushBefore(track: Track, clip: Clip): boolean {
  return trackClips(track).some(
    (candidate) => candidate.id !== clip.id && endExclusive(candidate.span) === clip.span.start,
  );
}

export function flushAfter(track: Track, clip: Clip): boolean {
  const end = endExclusive(clip.span);
  return trackClips(track).some((candidate) => candidate.id !== clip.id && candidate.span.start === end);
}

/**
 * Where a dragged asset will land.
 *
 * A line at the frame with the row lit behind it, which is the whole of what was missing: a drop used
 * to be a guess — you let go and found out where it went, on which track. Two signals rather than one
 * because the two questions are different: the line answers *when*, the tint answers *where*.
 *
 * `pointerEvents: none` throughout. An element under the pointer during a drag intercepts the
 * `dragleave` and `drop` events the lane is listening for, so an indicator that could be dropped onto
 * would cancel the drop it exists to describe.
 */
function DropIndicator({
  viewport,
  frame,
  height,
}: {
  readonly viewport: TimelineViewport;
  readonly frame: FrameIndex;
  readonly height: number;
}): ReactNode {
  // The viewport's own conversion, which already accounts for the scroll — computing it here would
  // be a second definition of where a frame is, and the two would drift the moment either changed.
  const left = frameToPx(viewport, frame);

  return (
    <div aria-hidden="true" data-drop-indicator="" className="pointer-events-none absolute inset-0 z-3">
      <div className="absolute inset-0 bg-primary/10" />
      <div
        className="absolute top-0 w-0.5 bg-primary shadow-[0_0_6px_var(--primary)]"
        style={{ left, height }}
      />
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
      className="pointer-events-none absolute inset-y-0 w-px bg-primary"
      style={{ left: px }}
    >
      <div
        className="absolute top-0 -left-1.5 size-3.5 bg-primary"
        style={{ clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }}
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
