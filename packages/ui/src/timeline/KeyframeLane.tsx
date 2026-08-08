import { type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  type Easing,
  type FrameIndex,
  type Keyframe,
  type KeyframeId,
  evaluateAt,
  frameIndex,
} from '@nos/core';
import { Mono } from '../primitives/Primitives.js';
import { token } from '../tokens/tokens.js';
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
  onRemoveKeyframe,
  onAddKeyframe,
}: KeyframeLaneProps): ReactNode {
  // Value under the playhead, which is what the right-edge readout shows.
  const clipRelativePlayhead = frameIndex(playhead - clipStart);
  const currentValue =
    keyframes.length === 0
      ? undefined
      : evaluateAt({ kind: 'animated', keyframes }, clipRelativePlayhead);

  const absoluteFrame = (keyframe: Keyframe): FrameIndex =>
    frameIndex(clipStart + keyframe.frame);

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
      const offsetPx =
        laneBounds === undefined ? moveEvent.clientX : moveEvent.clientX - laneBounds.left;
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
      style={{
        height: heightPx,
        position: 'relative',
        // Darker than a clip lane so the nesting reads without an indent, which would waste width.
        background: '#0e1013',
        borderBottom: `1px solid ${token.surface1}`,
        boxSizing: 'border-box',
      }}
    >
      {/* Baseline the markers sit on. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: Math.round(heightPx / 2) - 1,
          height: 1,
          background: token.borderControl,
        }}
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
          <div key={keyframe.id} style={{ position: 'absolute', left: 0, top: 0 }}>
            <div
              data-keyframe={keyframe.id}
              role="slider"
              aria-label={`${label} keyframe at frame ${absoluteFrame(keyframe)}`}
              aria-valuenow={keyframe.value}
              aria-valuetext={`${keyframe.value.toFixed(2)}, ${keyframe.ease}`}
              tabIndex={0}
              onPointerDown={handleDrag(keyframe)}
              onKeyDown={handleKeyDown(keyframe)}
              style={{
                position: 'absolute',
                left: px - size / 2,
                top: Math.round(heightPx / 2) - size / 2,
                width: size,
                height: size,
                background: isSelected ? '#8ef0d8' : token.ok,
                // Rotated square: a diamond reads as a discrete marker where a circle reads as a handle,
                // and it is the convention every editor uses for keyframes.
                transform: 'rotate(45deg)',
                boxShadow: isSelected ? '0 0 0 3px rgba(56, 193, 164, 0.22)' : 'none',
                cursor: 'ew-resize',
                touchAction: 'none',
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
                style={{
                  position: 'absolute',
                  left: px + size / 2 + 4,
                  top: isSelected ? Math.round(heightPx / 2) - 10 : Math.round(heightPx / 2) - 8,
                  height: isSelected ? 19 : 14,
                  padding: `0 ${isSelected ? 7 : 5}px`,
                  borderRadius: isSelected ? token.radiusControl : token.radiusInset,
                  background: '#17322e',
                  border: isSelected ? `1px solid ${'#2f5f56'}` : 'none',
                  color: isSelected ? '#8ef0d8' : '#6fd8bf',
                  font: `500 ${isSelected ? 10 : 8.5}px ${token.fontMono}`,
                  lineHeight: `${isSelected ? 17 : 14}px`,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                }}
              >
                {isSelected
                  ? `${keyframe.value.toFixed(2)} · ${keyframe.ease}`
                  : EASING_LABELS[keyframe.ease]}
              </button>
            )}
          </div>
        );
      })}

      {/* Value under the playhead, pinned right so it does not move as markers do. */}
      {currentValue !== undefined && (
        <div
          style={{
            position: 'absolute',
            right: token.space5,
            top: Math.round(heightPx / 2) - 7,
            pointerEvents: 'none',
          }}
        >
          <Mono tone={token.textSoft} style={{ font: `500 10px ${token.fontMono}` }}>
            {currentValue.toFixed(2)}
          </Mono>
        </div>
      )}
    </div>
  );
}

/** Easing order for the cycle-on-click affordance. */
export const EASING_CYCLE: readonly Easing[] = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'hold',
];

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
