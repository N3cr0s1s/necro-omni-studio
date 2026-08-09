import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useRef,
} from 'react';
import { type FrameIndex, type StoryAccent, type StoryBeat, type StoryBeatId, accentOf } from '@nos/core';
import { cn } from '@nos/ui/lib/utils';
import {
  type RulerTick,
  type TimelineViewport,
  frameToPx,
  generateTicks,
  pxToFrame,
} from '../timeline/viewport.js';
import { boardWidthPx, layoutBeats, rowsUsed } from './story-layout.js';

/**
 * The story board, per issue #33.
 *
 * Beats on the project's clock: what should happen, when, in prose. Nothing here is composited or
 * exported — it is the plan the cut is made against, and later the text a generator prompt is written
 * from.
 *
 * ## Why the accent is a spine and a tint, not a filled block
 *
 * The mockup in the issue draws each beat as a solid colour block with its title inside. Done
 * literally that means text on a chart role, and no chart role in this application's themes clears AA
 * as a text background — the shipped palettes reach 1.42:1 in the worst pairing, which is not a
 * borderline call. So the accent draws where it cannot be read *through*: a solid bar down the leading
 * edge, plus a wash of the same role behind body text that stays on the card colour. The board reads
 * as coloured blocks and every word on it stays legible in all six themes.
 *
 * ## Why dragging is pointer capture and not a library
 *
 * Same as the timeline's: the element must keep receiving moves after the pointer leaves it, which is
 * what capture is for, and a drag that stops when the pointer crosses into the next row is the failure
 * every hand-rolled attempt makes.
 */

/** Which categorical role draws each accent. Static, because Tailwind cannot see a built class name. */
const ACCENT_SPINE: Record<StoryAccent, string> = {
  1: 'bg-chart-1',
  2: 'bg-chart-2',
  3: 'bg-chart-3',
  4: 'bg-chart-4',
  5: 'bg-chart-5',
};

const ACCENT_WASH: Record<StoryAccent, string> = {
  1: 'bg-chart-1/10',
  2: 'bg-chart-2/10',
  3: 'bg-chart-3/10',
  4: 'bg-chart-4/10',
  5: 'bg-chart-5/10',
};

/** The class that paints an accent, for pickers elsewhere that must agree with the board. */
export function accentSpineClass(accent: StoryAccent): string {
  return ACCENT_SPINE[accent];
}

/** Height of the board's own ruler. */
const RULER_HEIGHT_PX = 26;

/** Height of one beat row, in pixels. Enough for a title and two lines of prose. */
const ROW_HEIGHT_PX = 76;

/** Grab width of the edge that resizes a beat. */
const HANDLE_PX = 6;

export interface StoryBoardProps {
  readonly beats: readonly StoryBeat[];
  readonly viewport: TimelineViewport;
  readonly selected?: StoryBeatId;
  /** Where the sequence is parked, drawn across the board so a beat can be lined up against the cut. */
  readonly playhead?: FrameIndex;
  readonly onSelect: (id: StoryBeatId) => void;
  readonly onMove?: (id: StoryBeatId, to: FrameIndex) => void;
  /** A new end frame for a beat being resized by its trailing edge. */
  readonly onResize?: (id: StoryBeatId, end: FrameIndex) => void;
  /** Double-clicking empty board, which is how a beat is added where it belongs. */
  readonly onAddAt?: (frame: FrameIndex) => void;
  readonly onSeek?: (frame: FrameIndex) => void;
}

export function StoryBoard({
  beats,
  viewport,
  selected,
  playhead,
  onSelect,
  onMove,
  onResize,
  onAddAt,
  onSeek,
}: StoryBoardProps): ReactNode {
  const surface = useRef<HTMLDivElement>(null);
  const blocks = layoutBeats(beats, viewport);
  const ticks = generateTicks(viewport);
  const width = boardWidthPx(blocks, viewport);

  /** Pointer x within the scrolling surface, which is the only origin the layout agrees with. */
  const frameAt = useCallback(
    (clientX: number): FrameIndex => {
      const bounds = surface.current?.getBoundingClientRect();
      return pxToFrame(viewport, clientX - (bounds?.left ?? 0));
    },
    [viewport],
  );

  return (
    <div
      ref={surface}
      className="relative min-w-full select-none"
      style={{ width, height: rowsUsed(blocks) * ROW_HEIGHT_PX + RULER_HEIGHT_PX }}
      onDoubleClick={(event) => {
        // Only on the board itself. A double-click that landed on a beat is a request to rename it,
        // and adding a beat under the pointer there would bury the one just double-clicked.
        if (event.target !== event.currentTarget) return;
        onAddAt?.(frameAt(event.clientX));
      }}
    >
      <BoardRuler
        ticks={ticks}
        {...(onSeek !== undefined ? { onSeek: (clientX: number) => onSeek(frameAt(clientX)) } : {})}
      />

      {playhead !== undefined && (
        <div
          aria-hidden="true"
          data-playhead="true"
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary"
          style={{ left: frameToPx(viewport, playhead) }}
        />
      )}

      {blocks.map((block) => (
        <BeatBlockBody
          key={block.beat.id}
          beat={block.beat}
          selected={block.beat.id === selected}
          style={{
            left: block.leftPx,
            width: block.widthPx,
            top: RULER_HEIGHT_PX + block.row * ROW_HEIGHT_PX,
            height: ROW_HEIGHT_PX - 6,
          }}
          onSelect={() => onSelect(block.beat.id)}
          {...(onMove !== undefined
            ? {
                onDragTo: (clientX: number, grabbedAtPx: number) =>
                  onMove(block.beat.id, frameAt(clientX - grabbedAtPx)),
              }
            : {})}
          {...(onResize !== undefined
            ? { onResizeTo: (clientX: number) => onResize(block.beat.id, frameAt(clientX)) }
            : {})}
        />
      ))}
    </div>
  );
}

function BoardRuler({
  ticks,
  onSeek,
}: {
  readonly ticks: readonly RulerTick[];
  readonly onSeek?: (clientX: number) => void;
}): ReactNode {
  return (
    <div
      className={cn(
        'absolute inset-x-0 top-0 overflow-hidden border-b bg-background',
        onSeek !== undefined && 'cursor-text',
      )}
      style={{ height: RULER_HEIGHT_PX }}
      onPointerDown={onSeek === undefined ? undefined : (event) => onSeek(event.clientX)}
    >
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
    </div>
  );
}

function BeatBlockBody({
  beat,
  selected,
  style,
  onSelect,
  onDragTo,
  onResizeTo,
}: {
  readonly beat: StoryBeat;
  readonly selected: boolean;
  readonly style: CSSProperties;
  readonly onSelect: () => void;
  readonly onDragTo?: (clientX: number, grabbedAtPx: number) => void;
  readonly onResizeTo?: (clientX: number) => void;
}): ReactNode {
  const accent = accentOf(beat);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
      // Left button only: a right-click here is a context menu, and a middle-click that dragged a beat
      // across the plan would be a change nobody asked for.
      if (event.button !== 0) return;
      event.stopPropagation();
      onSelect();

      const handler = mode === 'move' ? onDragTo : onResizeTo;
      if (handler === undefined) return;

      // Where inside the block the pointer went down, so the beat does not jump its own left edge to
      // the cursor on the first move.
      const grabbedAtPx = event.clientX - event.currentTarget.getBoundingClientRect().left;
      const target = event.currentTarget;
      // Optional call: jsdom has no pointer capture, and the drag is still exercised without it.
      target.setPointerCapture?.(event.pointerId);

      const move = (moved: PointerEvent): void => {
        if (mode === 'move') onDragTo?.(moved.clientX, grabbedAtPx);
        else onResizeTo?.(moved.clientX);
      };
      const finish = (): void => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', finish);
        target.removeEventListener('pointercancel', finish);
      };

      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', finish);
      target.addEventListener('pointercancel', finish);
    },
    [onDragTo, onResizeTo, onSelect],
  );

  return (
    <article
      data-beat={beat.id}
      aria-label={beat.title === '' ? 'Untitled beat' : beat.title}
      style={style}
      onPointerDown={(event) => startDrag(event, 'move')}
      className={cn(
        'absolute flex overflow-hidden rounded-md border bg-card text-left',
        onDragTo !== undefined && 'cursor-grab active:cursor-grabbing',
        selected && 'ring-2 ring-ring',
      )}
    >
      {/* The accent, where it cannot be read through. */}
      <div aria-hidden="true" className={cn('w-1 flex-none', ACCENT_SPINE[accent])} />

      <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1', ACCENT_WASH[accent])}>
        <button
          type="button"
          onClick={onSelect}
          className="truncate text-left text-xs font-medium text-card-foreground"
        >
          {beat.title === '' ? 'Untitled beat' : beat.title}
        </button>
        {/* The prose, clamped. The board says what a beat is about; the whole of it is edited beside. */}
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{beat.notes}</p>
        {beat.references.length > 0 && (
          <span className="mt-auto font-mono text-[10px] text-muted-foreground">
            {beat.references.length} ref{beat.references.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {onResizeTo !== undefined && (
        <div
          data-resize={beat.id}
          aria-hidden="true"
          onPointerDown={(event) => startDrag(event, 'resize')}
          className="absolute inset-y-0 right-0 cursor-ew-resize hover:bg-ring/40"
          style={{ width: HANDLE_PX }}
        />
      )}
    </article>
  );
}
