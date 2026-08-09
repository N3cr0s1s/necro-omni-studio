import { type PointerEvent as ReactPointerEvent, type ReactNode, useRef, useState } from 'react';
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
  /**
   * The curve the user settled on, once per gesture.
   *
   * **One drag is one history entry**, which is the rule every other gesture in this editor follows
   * and the one this component quietly broke on the way in: both callers were wired to the live
   * channel below, so dragging a handle across the box wrote a commit per pointer move and buried
   * whatever came before it under forty entries of "set fade curve".
   *
   * The handle stays responsive because the drag is held here as a draft and drawn from it — the same
   * shape the clip drag uses, where the preview follows the pointer and the store hears about it once.
   */
  readonly onCommit: (points: BezierEase) => void;
  /**
   * Every intermediate position, for a caller that can show one without recording it.
   *
   * Optional, and deliberately not what a caller reaches for first: anything wired here that writes to
   * the document is writing a history entry per pointer move.
   */
  readonly onChange?: (points: BezierEase) => void;
}

/** Drawing box, in its own coordinates. The SVG scales; these decide the proportions. */
const BOX = 100;
/** Headroom above and below the unit square, so an overshooting curve is drawn rather than clipped. */
const MARGIN = 30;

export function BezierEditor({ points, onChange, onCommit }: BezierEditorProps): ReactNode {
  const surface = useRef<SVGSVGElement | null>(null);
  /**
   * The curve while a handle is held.
   *
   * Cleared on release, so the committed document becomes the source of truth again the moment the
   * gesture ends — a draft that outlived its drag would show a curve the project does not have.
   */
  const [draft, setDraft] = useState<BezierEase | undefined>(undefined);
  const shown = draft ?? points;

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
      setDraft(latest);
      onChange?.(latest);
    };

    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraft(undefined);
      // One history entry for the gesture. Every move before this was a draft held here.
      onCommit(latest);
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
        x2={shown.x1 * BOX}
        y2={(1 - shown.y1) * BOX}
        className="stroke-muted-foreground"
        strokeWidth={0.75}
      />
      <line
        x1={BOX}
        y1={0}
        x2={shown.x2 * BOX}
        y2={(1 - shown.y2) * BOX}
        className="stroke-muted-foreground"
        strokeWidth={0.75}
      />

      <path d={curvePath(shown)} className="fill-none stroke-primary" strokeWidth={1.75} />

      <Handle
        index={1}
        x={shown.x1 * BOX}
        y={(1 - shown.y1) * BOX}
        label={`control point 1 at ${round(shown.x1)}, ${round(shown.y1)}`}
        onPointerDown={drag(1)}
      />
      <Handle
        index={2}
        x={shown.x2 * BOX}
        y={(1 - shown.y2) * BOX}
        label={`control point 2 at ${round(shown.x2)}, ${round(shown.y2)}`}
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
