import { type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  type Easing,
  type FrameIndex,
  type Keyframe,
  type KeyframeId,
  evaluateAt,
  frameIndex,
} from '@nos/core';
import { Badge } from '@nos/ui/components/ui/badge';
import { NumberField } from '../controls/NumberField.js';
import { cn } from '@nos/ui/lib/utils';
import { type TimelineViewport, frameToPx } from './viewport.js';

/**
 * A keyframe lane: one animated parameter, drawn under its clip.
 *
 * The spec's model, laid out as mockup 1b shows it — per-marker easing as a badge on the marker, a drag
 * being one undo step, and the value readout at the right edge.
 *
 * ## Why easing is on the marker
 *
 * A keyframe's easing governs the segment *leaving* it, so the badge sits to the right of its diamond. That
 * is also why the last marker shows no badge: its easing governs nothing. Putting the badge on the segment
 * instead would be equally defensible, but then `hold` — which means "keep this value until the next
 * marker" — would read as a property of empty space rather than of the value that is being held.
 */

export interface KeyframeLaneProps {
  /** Parameter label shown in the header column, e.g. `film_grain · amount`. */
  readonly label: string;
  readonly keyframes: readonly Keyframe[];
  /** Where the clip starts, so clip-relative keyframe positions can be placed absolutely. */
  readonly clipStart: FrameIndex;
  readonly viewport: TimelineViewport;
  readonly playhead: FrameIndex;
  readonly selected?: KeyframeId;
  readonly heightPx?: number;

  readonly onSelectKeyframe?: (keyframe: KeyframeId) => void;
  /** A drag in progress. The caller opens a gesture so the whole drag is one undo step. */
  readonly onDragKeyframe?: (keyframe: KeyframeId, toFrame: FrameIndex) => void;
  readonly onDragStart?: (keyframe: KeyframeId) => void;
  readonly onDragEnd?: () => void;
  readonly onCycleEasing?: (keyframe: KeyframeId) => void;
  /**
   * A new value for a marker, typed into the readout at the lane's right edge.
   *
   * The spec's §6.4 asks for it in as many words, and without it an animated parameter is unwritable:
   * the inspector disables a parameter's slider once it is keyframed — correctly, so two controls
   * cannot disagree — which left the value with nowhere to be edited at all.
   */
  readonly onChangeValue?: (keyframe: KeyframeId, value: number) => void;
  readonly onRemoveKeyframe?: (keyframe: KeyframeId) => void;
  /** Double-click on empty lane space adds a keyframe there. */
  readonly onAddKeyframe?: (atFrame: FrameIndex) => void;
}

/** Lane height from the mockups. */
export const KEYFRAME_LANE_HEIGHT = 34;

const MARKER_SIZE = 11;
const SELECTED_MARKER_SIZE = 15;

/** Short labels, so a badge stays narrow enough to sit beside its marker. */
const EASING_LABELS: Readonly<Record<Easing, string>> = {
  linear: 'linear',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-io',
  hold: 'hold',
};

export function KeyframeLane({
  label,
  keyframes,
  clipStart,
  viewport,
  playhead,
  selected,
  heightPx = KEYFRAME_LANE_HEIGHT,
  onSelectKeyframe,
  onDragKeyframe,
  onDragStart,
  onDragEnd,
  onCycleEasing,
  onChangeValue,
  onRemoveKeyframe,
  onAddKeyframe,
}: KeyframeLaneProps): ReactNode {
  // Value under the playhead, which is what the right-edge readout shows.
  const clipRelativePlayhead = frameIndex(playhead - clipStart);
  const currentValue =
    keyframes.length === 0 ? undefined : evaluateAt({ kind: 'animated', keyframes }, clipRelativePlayhead);

  const absoluteFrame = (keyframe: Keyframe): FrameIndex => frameIndex(clipStart + keyframe.frame);

  // Only when the selected marker is one of *this* lane's. Selection is held per clip, so without the
  // check every lane would open a field for a marker belonging to another parameter.
  const selectedHere = keyframes.find((keyframe) => keyframe.id === selected);

  const handleDrag = (keyframe: Keyframe) => (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const target = event.currentTarget;

    // Pointer capture keeps events flowing to the marker while the pointer is outside it, which happens
    // immediately — the marker is 11 px wide and a drag is not. Treated as an enhancement rather than a
    // requirement: it is absent in some environments, and a marker that cannot be dragged at all is a far
    // worse outcome than one that loses events if the window is left.
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is unavailable or the pointer id is already released. The window listeners below carry
      // the drag regardless.
    }

    onSelectKeyframe?.(keyframe.id);
    onDragStart?.(keyframe.id);

    // Listeners go on the marker *and* the window. The marker receives them while capture holds; the
    // window is the fallback, and it is also what guarantees the drag ends when the pointer is released
    // somewhere else entirely.
    const laneBounds = target.parentElement?.parentElement?.getBoundingClientRect();

    const move = (moveEvent: globalThis.PointerEvent): void => {
      const offsetPx = laneBounds === undefined ? moveEvent.clientX : moveEvent.clientX - laneBounds.left;
      const frame = frameIndex(
        Math.max(0, Math.round(viewport.scrollFrame + offsetPx * viewport.framesPerPixel)),
      );
      onDragKeyframe?.(keyframe.id, frame);
    };

    const detach = (): void => {
      for (const node of [target, window] as const) {
        node.removeEventListener('pointermove', move as EventListener);
        node.removeEventListener('pointerup', up as EventListener);
        node.removeEventListener('pointercancel', up as EventListener);
      }
    };

    function up(): void {
      detach();
      onDragEnd?.();
    }

    for (const node of [target, window] as const) {
      node.addEventListener('pointermove', move as EventListener);
      node.addEventListener('pointerup', up as EventListener);
      // `pointercancel` matters: without it an interrupted drag (a system gesture, a lost device) leaves
      // the caller's undo gesture open, silently merging every later edit into it.
      node.addEventListener('pointercancel', up as EventListener);
    }
  };

  const handleKeyDown =
    (keyframe: Keyframe) =>
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const step = event.shiftKey ? 10 : 1;
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          onDragKeyframe?.(keyframe.id, frameIndex(absoluteFrame(keyframe) - step));
          break;
        case 'ArrowRight':
          event.preventDefault();
          onDragKeyframe?.(keyframe.id, frameIndex(absoluteFrame(keyframe) + step));
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          onCycleEasing?.(keyframe.id);
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          onRemoveKeyframe?.(keyframe.id);
          break;
        default:
          break;
      }
    };

  return (
    <div
      data-keyframe-lane={label}
      role="group"
      aria-label={`${label} keyframes`}
      onDoubleClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const offsetPx = event.clientX - bounds.left;
        onAddKeyframe?.(
          frameIndex(Math.max(0, Math.round(viewport.scrollFrame + offsetPx * viewport.framesPerPixel))),
        );
      }}
      // Recessed relative to a clip lane so the nesting reads without an indent, which would waste
      // width. `muted` is the role for exactly that — a surface that is behind the content.
      className="relative border-b bg-muted/40"
      style={{ height: heightPx }}
    >
      {/* Baseline the markers sit on. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 h-px bg-border"
        style={{ top: Math.round(heightPx / 2) - 1 }}
      />

      {keyframes.map((keyframe, index) => {
        const px = frameToPx(viewport, absoluteFrame(keyframe));
        // Off-screen markers are skipped, keeping the DOM proportional to what is visible.
        if (px < -SELECTED_MARKER_SIZE || px > viewport.widthPx + 120) return null;

        const isSelected = selected === keyframe.id;
        const size = isSelected ? SELECTED_MARKER_SIZE : MARKER_SIZE;
        // The final marker's easing governs no segment, so showing a badge for it would be misleading.
        const showBadge = index < keyframes.length - 1;

        return (
          <div key={keyframe.id} className="absolute top-0 left-0">
            <div
              data-keyframe={keyframe.id}
              role="slider"
              aria-label={`${label} keyframe at frame ${absoluteFrame(keyframe)}`}
              aria-valuenow={keyframe.value}
              aria-valuetext={`${keyframe.value.toFixed(2)}, ${keyframe.ease}`}
              tabIndex={0}
              onPointerDown={handleDrag(keyframe)}
              onKeyDown={handleKeyDown(keyframe)}
              className={cn(
                // Rotated square: a diamond reads as a discrete marker where a circle reads as a handle,
                // and it is the convention every editor uses for keyframes.
                'absolute rotate-45 cursor-ew-resize touch-none bg-chart-2',
                isSelected && 'ring-3 ring-chart-2/25',
              )}
              style={{
                left: px - size / 2,
                top: Math.round(heightPx / 2) - size / 2,
                width: size,
                height: size,
              }}
            />

            {showBadge && (
              <button
                type="button"
                aria-label={`Easing after frame ${absoluteFrame(keyframe)}: ${keyframe.ease}. Activate to change.`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCycleEasing?.(keyframe.id);
                }}
                className="absolute"
                style={{
                  left: px + size / 2 + 4,
                  top: isSelected ? Math.round(heightPx / 2) - 10 : Math.round(heightPx / 2) - 8,
                }}
              >
                <Badge
                  variant="secondary"
                  className={cn(
                    // The badge's own foreground: this is a *number the user reads and edits*, and
                    // `chart-2` on a secondary surface is 3.08:1 at its worst across the themes.
                    'cursor-pointer font-mono whitespace-nowrap',
                    isSelected ? 'h-5 px-1.5 text-[10px]' : 'h-3.5 px-1 text-[8.5px]',
                  )}
                >
                  {isSelected
                    ? `${keyframe.value.toFixed(2)} · ${keyframe.ease}`
                    : EASING_LABELS[keyframe.ease]}
                </Badge>
              </button>
            )}
          </div>
        );
      })}

      {/*
        The readout, pinned right so it does not move as markers do — and editable when a marker of
        this lane is selected. The two are the same corner deliberately: it is where the eye already
        goes for a number, and a separate field somewhere else would be one more thing to find.
      */}
      {selectedHere !== undefined && onChangeValue !== undefined ? (
        <div className="absolute right-4" style={{ top: Math.round(heightPx / 2) - 11 }}>
          <NumberField
            key={selectedHere.id}
            aria-label={`Value at frame ${selectedHere.frame}`}
            value={selectedHere.value}
            onCommit={(value) => onChangeValue(selectedHere.id, value)}
            className="h-5.5 w-20 px-1 py-0 text-center font-mono text-[10px] tabular-nums"
          />
        </div>
      ) : (
        currentValue !== undefined && (
          <div
            className="pointer-events-none absolute right-4 font-mono text-[10px] font-medium text-muted-foreground"
            style={{ top: Math.round(heightPx / 2) - 7 }}
          >
            {currentValue.toFixed(2)}
          </div>
        )
      )}
    </div>
  );
}

/** Easing order for the cycle-on-click affordance. */
export const EASING_CYCLE: readonly Easing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'];

/**
 * The next easing in the cycle.
 *
 * Cycling rather than opening a menu: five options is few enough that clicking through them is faster than
 * a picker, and it keeps the badge a single control. An unrecognized value restarts at linear, which is
 * also how a project from a build with Bezier support degrades.
 */
export function nextEasing(current: Easing): Easing {
  const index = EASING_CYCLE.indexOf(current);
  if (index < 0) return 'linear';
  return EASING_CYCLE[(index + 1) % EASING_CYCLE.length]!;
}

/** Header label for a lane, matching how the effect stack names a parameter. */
export function laneLabel(effectLabel: string, paramLabel: string): string {
  return `${effectLabel} · ${paramLabel}`;
}
