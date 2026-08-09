import { type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  type Easing,
  type FrameIndex,
  type Keyframe,
  type KeyframeId,
  animatedNumber,
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
  /**
   * A drag in progress. The caller opens a gesture so the whole drag is one undo step.
   *
   * Two axes, because a marker has two coordinates and the lane draws it at both. Dragging changed
   * only the frame, so the one thing a curve is *for* — its shape — could be adjusted nowhere except
   * a number field, one marker at a time. `toValue` is what the vertical position of the pointer maps
   * to under the lane's current range.
   */
  readonly onDragKeyframe?: (keyframe: KeyframeId, toFrame: FrameIndex, toValue: number) => void;
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

/** Lane height from the mockups. The smallest of the three; see `KEYFRAME_LANE_HEIGHTS`. */
export const KEYFRAME_LANE_HEIGHT = 34;

/**
 * The heights a lane can be given, shortest first.
 *
 * This is the "zoom" the report asks for — *"which brings with it that I want to be able to magnify,
 * so it is more precise"*. Magnifying a value curve means more pixels per unit of value, and on a
 * fixed 34-pixel lane a marker at 0.51 and one at 0.55 are the same pixel however carefully they are
 * dragged. A taller lane is the whole of the fix; nothing else about the lane changes.
 *
 * Three steps rather than a free drag: a lane is not a track and does not carry a resize edge, and
 * three presses covers the useful range.
 */
export const KEYFRAME_LANE_HEIGHTS: readonly number[] = [34, 72, 140];

/** Room kept above and below the value range, so a marker at an extreme is not half off the lane. */
const VALUE_PADDING_PX = 9;

/**
 * The value range a lane draws against.
 *
 * The keyframes' own extent, not a fixed 0–1: an effect parameter can be a blur radius in pixels or a
 * rotation in degrees, and a lane scaled to the wrong range would draw every marker on one edge. A
 * parameter whose markers all share a value gets a range around it rather than a zero-height one,
 * which would put every marker at the same pixel and make the curve undraggable.
 */
export function laneValueRange(keyframes: readonly Keyframe[]): {
  readonly min: number;
  readonly max: number;
} {
  if (keyframes.length === 0) return { min: 0, max: 1 };

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const keyframe of keyframes) {
    if (keyframe.value < min) min = keyframe.value;
    if (keyframe.value > max) max = keyframe.value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };

  if (max - min < 1e-9) {
    // A flat parameter still has to be draggable, and the span has to scale with the value: ±0.5
    // around a rotation of 180 would be a lane nobody could use.
    const reach = Math.max(0.5, Math.abs(min) * 0.5);
    return { min: min - reach, max: max + reach };
  }
  return { min, max };
}

const MARKER_SIZE = 11;
const SELECTED_MARKER_SIZE = 15;

/** Short labels, so a badge stays narrow enough to sit beside its marker. */
const EASING_LABELS: Readonly<Record<Easing, string>> = {
  linear: 'linear',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-io',
  hold: 'hold',
  bezier: 'curve',
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

  // Markers sit at their *value*, not on a shared baseline. A lane that drew every marker in a row
  // said nothing about the shape of the animation, which is the thing a curve exists to show — and
  // the report asked for the line itself, grabbable and movable.
  const range = laneValueRange(keyframes);
  const usable = Math.max(1, heightPx - VALUE_PADDING_PX * 2);
  const valueToY = (value: number): number =>
    VALUE_PADDING_PX + (1 - (value - range.min) / (range.max - range.min)) * usable;
  const yToValue = (y: number): number =>
    range.min + (1 - (y - VALUE_PADDING_PX) / usable) * (range.max - range.min);

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
      // The vertical axis is the value. Unclamped by the lane's own range on purpose: a drag to the
      // top edge should be able to *raise* the range rather than stop at whatever the tallest
      // existing marker happens to be, which would make a maximum impossible to exceed.
      const offsetY = laneBounds === undefined ? 0 : moveEvent.clientY - laneBounds.top;
      onDragKeyframe?.(keyframe.id, frame, laneBounds === undefined ? keyframe.value : yToValue(offsetY));
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
      // A hundredth of the lane's span, so a nudge is the same *proportion* of the curve whatever the
      // parameter's units are — a step of one would be imperceptible on a rotation and enormous on an
      // opacity.
      const valueStep = ((range.max - range.min) / 100) * step;
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          onDragKeyframe?.(keyframe.id, frameIndex(absoluteFrame(keyframe) - step), keyframe.value);
          break;
        case 'ArrowRight':
          event.preventDefault();
          onDragKeyframe?.(keyframe.id, frameIndex(absoluteFrame(keyframe) + step), keyframe.value);
          break;
        case 'ArrowUp':
          event.preventDefault();
          onDragKeyframe?.(keyframe.id, absoluteFrame(keyframe), keyframe.value + valueStep);
          break;
        case 'ArrowDown':
          event.preventDefault();
          onDragKeyframe?.(keyframe.id, absoluteFrame(keyframe), keyframe.value - valueStep);
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
      {/* The curve itself: the value at every frame, through the same evaluator the renderer uses.
          Drawing it any other way would flatter a shape the picture does not have. */}
      <ValueCurve
        keyframes={keyframes}
        clipStart={clipStart}
        viewport={viewport}
        valueToY={valueToY}
        heightPx={heightPx}
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
                'absolute rotate-45 cursor-move touch-none bg-chart-2',
                isSelected && 'ring-3 ring-chart-2/25',
              )}
              style={{
                left: px - size / 2,
                top: valueToY(keyframe.value) - size / 2,
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
                // Beside the marker rather than on the lane's midline, now that a marker sits at its
                // own value: a badge pinned to the middle would drift away from the diamond it labels
                // and end up naming whichever marker happened to be nearest.
                style={{
                  left: px + size / 2 + 4,
                  top: valueToY(keyframe.value) - (isSelected ? 10 : 8),
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

/**
 * The animated value, drawn across the lane.
 *
 * Sampled through `evaluateAt` — the function the compositor and the mixer call — rather than by
 * interpolating between markers here. Any second implementation of "what is this parameter at this
 * frame" drifts from the first, and the drift would show as a curve that does not match the picture.
 *
 * One sample every two pixels: the lane is at most 140 px tall, so a straight segment between two
 * samples that close is under a pixel of error even through the steepest part of a hard ease. `hold`
 * is the exception the sampling handles for free — it draws as a step, because that is what it is.
 */
function ValueCurve({
  keyframes,
  clipStart,
  viewport,
  valueToY,
  heightPx,
}: {
  readonly keyframes: readonly Keyframe[];
  readonly clipStart: FrameIndex;
  readonly viewport: TimelineViewport;
  readonly valueToY: (value: number) => number;
  readonly heightPx: number;
}): ReactNode {
  if (keyframes.length === 0) return undefined;

  const param = animatedNumber(keyframes);
  const width = Math.max(1, viewport.widthPx);
  const points: string[] = [];
  for (let px = 0; px <= width; px += 2) {
    const frame = frameIndex(Math.round(viewport.scrollFrame + px * viewport.framesPerPixel - clipStart));
    points.push(`${px},${valueToY(evaluateAt(param, frame)).toFixed(2)}`);
  }

  return (
    <svg
      aria-hidden="true"
      data-value-curve=""
      className="pointer-events-none absolute inset-0"
      width={width}
      height={heightPx}
      viewBox={`0 0 ${width} ${heightPx}`}
      preserveAspectRatio="none"
    >
      <polyline points={points.join(' ')} className="fill-none stroke-chart-2/70" strokeWidth={1.5} />
    </svg>
  );
}
