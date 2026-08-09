import { type PointerEvent as ReactPointerEvent, type ReactNode, useRef } from 'react';
import { type BezierEase, bezierEase, evaluateBezier } from '@nos/core';

/**
 * The curve, drawn and dragged.
 *
 * Issue #37 asked for "a grabbable, movable line where I can set whether it is bezier or my own
 * curve". Four numbers describe such a curve, and four number fields are a terrible way to author
 * one: nobody knows what `0.42, 0, 0.58, 1` looks like, and finding the shape you want by typing is
 * a search through a space you cannot see. So the curve is the control.
 *
 * ## Why the y axis is not clamped and the x axis is
 *
 * Time has to run forwards. A control point past either end of the segment makes the curve
 * non-monotonic in time, which means the value would go backwards — something no evaluator in this
 * project can express and no user asked for. Value is different: a handle pulled above the top is a
 * curve that overshoots and settles, which is exactly what makes a move feel like it has weight, and
 * it is one of the two reasons to want a custom curve at all.
 *
 * The box therefore shows a margin above and below the unit square, and the overshoot is drawn
 * rather than clipped — a curve whose peak is cut off by the frame looks like a rendering bug.
 *
 * ## Why it samples the real evaluator
 *
 * The path is drawn by calling `evaluateBezier`, the same function the render loop uses, rather than
 * by handing the control points to SVG's own cubic. SVG would draw the curve parameterized by its
 * internal `s`; the evaluator solves for time first. The two differ visibly wherever the control
 * points are uneven, and a preview that flatters the curve is worse than no preview.
 */

export interface BezierEditorProps {
  readonly points: BezierEase;
  readonly onChange: (points: BezierEase) => void;
  /** Live while dragging, committed once at the end, so a drag is one history entry. */
  readonly onCommit?: (points: BezierEase) => void;
}

/** Drawing box, in its own coordinates. The SVG scales; these decide the proportions. */
const BOX = 100;
/** Headroom above and below the unit square, so an overshooting curve is drawn rather than clipped. */
const MARGIN = 30;

export function BezierEditor({ points, onChange, onCommit }: BezierEditorProps): ReactNode {
  const surface = useRef<SVGSVGElement | null>(null);

  /** Screen position to curve coordinates. y is inverted: SVG grows downwards, a value grows up. */
  const toCurve = (event: PointerEvent | ReactPointerEvent): { x: number; y: number } | undefined => {
    const element = surface.current;
    if (element === null) return undefined;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return undefined;

    const x = ((event.clientX - box.left) / box.width) * BOX;
    const y = ((event.clientY - box.top) / box.height) * (BOX + MARGIN * 2) - MARGIN;
    return { x: x / BOX, y: 1 - y / BOX };
  };

  const drag = (handle: 1 | 2) => (event: ReactPointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.preventDefault();

    let latest = points;
    const move = (moved: PointerEvent): void => {
      const at = toCurve(moved);
      if (at === undefined) return;
      latest =
        handle === 1
          ? bezierEase({ ...points, x1: at.x, y1: at.y })
          : bezierEase({ ...points, x2: at.x, y2: at.y });
      onChange(latest);
    };

    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // One history entry for the gesture. Every move before this was a preview.
      onCommit?.(latest);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <svg
      ref={surface}
      role="group"
      aria-label="easing curve"
      viewBox={`0 ${-MARGIN} ${BOX} ${BOX + MARGIN * 2}`}
      className="h-32 w-full touch-none rounded border bg-muted/20"
      preserveAspectRatio="none"
    >
      {/* The unit square, so the two ends of the segment are visible as places rather than implied by
          the curve reaching them. */}
      <rect x={0} y={0} width={BOX} height={BOX} className="fill-none stroke-border" strokeWidth={0.5} />
      <line
        x1={0}
        y1={BOX}
        x2={BOX}
        y2={0}
        className="stroke-border"
        strokeWidth={0.5}
        strokeDasharray="2 2"
      />

      {/* Handle arms first, so the curve and the grips paint over them. */}
      <line
        x1={0}
        y1={BOX}
        x2={points.x1 * BOX}
        y2={(1 - points.y1) * BOX}
        className="stroke-muted-foreground"
        strokeWidth={0.75}
      />
      <line
        x1={BOX}
        y1={0}
        x2={points.x2 * BOX}
        y2={(1 - points.y2) * BOX}
        className="stroke-muted-foreground"
        strokeWidth={0.75}
      />

      <path d={curvePath(points)} className="fill-none stroke-primary" strokeWidth={1.75} />

      <Handle
        index={1}
        x={points.x1 * BOX}
        y={(1 - points.y1) * BOX}
        label={`control point 1 at ${round(points.x1)}, ${round(points.y1)}`}
        onPointerDown={drag(1)}
      />
      <Handle
        index={2}
        x={points.x2 * BOX}
        y={(1 - points.y2) * BOX}
        label={`control point 2 at ${round(points.x2)}, ${round(points.y2)}`}
        onPointerDown={drag(2)}
      />
    </svg>
  );
}

/**
 * The curve as a polyline, sampled through the evaluator the renderer uses.
 *
 * Forty samples: the curve is at most 140 units tall in a box a couple of hundred pixels wide, and the
 * error of a straight segment between two samples that close is well under a pixel even where the
 * curve is steepest.
 */
function curvePath(points: BezierEase): string {
  const steps = 40;
  const parts: string[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const value = evaluateBezier(points, t);
    parts.push(`${step === 0 ? 'M' : 'L'}${(t * BOX).toFixed(2)} ${((1 - value) * BOX).toFixed(2)}`);
  }
  return parts.join(' ');
}

function Handle({
  index,
  x,
  y,
  label,
  onPointerDown,
}: {
  readonly index: 1 | 2;
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly onPointerDown: (event: ReactPointerEvent<SVGCircleElement>) => void;
}): ReactNode {
  return (
    <circle
      data-bezier-handle={index}
      role="slider"
      aria-label={label}
      // The two-dimensional value has no single number, and a slider with no range reads as broken to
      // a screen reader — so the position is stated in the label and the numeric fields beside the
      // editor remain the accessible way to set it exactly.
      aria-valuetext={label}
      tabIndex={0}
      cx={x}
      cy={y}
      r={4}
      className="cursor-grab fill-primary stroke-background"
      strokeWidth={1.5}
      onPointerDown={onPointerDown}
    />
  );
}

function round(value: number): string {
  return value.toFixed(2);
}
