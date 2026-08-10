import { useCallback, useMemo, useState } from 'react';

/**
 * Looking closer at the frame.
 *
 * The preview letterboxes the picture into whatever space the panel has, which is the right default
 * and the only thing it could do — but it means the frame is almost never shown at its own size. On a
 * 1080p project in a half-window panel that is around two thirds, and at two thirds you cannot judge
 * the one class of thing this application exists to produce: a mask edge, a title's kerning, the grain
 * a shader just added. The mockups show `fit · 68%` for the same reason — the number matters because
 * it tells you what you are *not* seeing.
 *
 * ## Why a transform rather than a bigger canvas
 *
 * The drawing buffer stays at the project resolution, always. Rendering more pixels because someone
 * zoomed in would make the preview disagree with the export, which is the one guarantee §6.7 rests on.
 * What changes is how large that buffer is *drawn* — so zooming shows the frame's real pixels bigger,
 * which is exactly what inspecting means, and never invents any.
 *
 * It also keeps the mask overlay correct for free. The overlay lives inside the same transformed box,
 * so a click's `getBoundingClientRect` arithmetic is against the rectangle the user actually sees, and
 * a point lands where it was put at any zoom.
 */

/**
 * How far in it goes.
 *
 * `1` is fit — the state the preview has always been in — so nothing below it exists: zooming *out*
 * past fit would letterbox an already letterboxed picture and show the user more of nothing. Eight is
 * where a 1080p frame's pixels are large enough to count individually, and past that the control is
 * being used as a magnifier for a thing the screen cannot add detail to.
 */
export const ZOOM_RANGE = { min: 1, max: 8 } as const;

export interface PreviewZoom {
  /** `1` is fit. Multiplies the letterboxed size rather than replacing it. */
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
  /** True when anything is off default, so a caller can offer the way back. */
  readonly zoomed: boolean;
  zoomBy(factor: number): void;
  panBy(dx: number, dy: number): void;
  /** Back to fit and centred, which is the state the preview has always had. */
  reset(): void;
}

export function clampZoom(scale: number): number {
  // `NaN` only. It has no order, so `Math.min`/`Math.max` propagate it — and a `NaN` scale reaches CSS
  // as an invalid transform, which makes the picture vanish with nothing logged anywhere. Infinity is
  // ordered and clamps to the ceiling like any other number too large.
  if (Number.isNaN(scale)) return ZOOM_RANGE.min;
  return Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, scale));
}

/**
 * Keeps the picture within reach.
 *
 * A free pan lets the frame be dragged entirely off the panel, leaving an empty box and no clue how to
 * get back — the kind of state a user escapes by reloading. The bound is the overhang: at scale `s` a
 * picture is `s` times its fitted size, so half the excess in each direction is exactly the distance
 * at which its edge meets the panel's.
 *
 * At fit there is no excess and the answer is always centred, which is why zooming out to `1` re-centres
 * on its own rather than needing to be told.
 */
export function clampPan(
  pan: { readonly x: number; readonly y: number },
  scale: number,
  box: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const limitX = Math.max(0, (box.width * scale - box.width) / 2);
  const limitY = Math.max(0, (box.height * scale - box.height) / 2);
  return {
    x: Math.min(limitX, Math.max(-limitX, pan.x)),
    y: Math.min(limitY, Math.max(-limitY, pan.y)),
  };
}

/**
 * What the readout says: `fit · 68%`, or `136%` once it has been zoomed.
 *
 * Both numbers are the same measurement — how large a project pixel is drawn — and the word `fit` is
 * what distinguishes "this is as much as the panel holds" from "you asked for this". Without it, a
 * user who has never touched the zoom would read `68%` as something they had done.
 *
 * Nothing at all before the picture has been measured. `0%` would be a claim about a frame that has
 * not been laid out yet.
 */
export function describeZoom(
  pictureWidth: number | undefined,
  projectWidth: number,
  scale: number,
): string | undefined {
  if (pictureWidth === undefined || pictureWidth <= 0 || projectWidth <= 0) return undefined;

  const percent = Math.round((pictureWidth / projectWidth) * scale * 100);
  return scale === ZOOM_RANGE.min ? `fit · ${percent}%` : `${percent}%`;
}

export function usePreviewZoom(box: { readonly width: number; readonly height: number }): PreviewZoom {
  // Typed, or `as const` on the range narrows the state to the literal `1` and nothing may change it.
  const [scale, setScale] = useState<number>(ZOOM_RANGE.min);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const zoomBy = useCallback(
    (factor: number) => {
      setScale((current) => {
        const next = clampZoom(current * factor);
        // Re-clamped against the *new* scale: zooming out shrinks the overhang, and a pan that was
        // legal a moment ago would otherwise leave the picture hanging off the edge it no longer
        // reaches.
        setPan((currentPan) => clampPan(currentPan, next, box));
        return next;
      });
    },
    [box],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      setPan((current) => clampPan({ x: current.x + dx, y: current.y + dy }, scale, box));
    },
    [box, scale],
  );

  const reset = useCallback(() => {
    setScale(ZOOM_RANGE.min);
    setPan({ x: 0, y: 0 });
  }, []);

  return useMemo(
    () => ({
      scale,
      panX: pan.x,
      panY: pan.y,
      zoomed: scale !== ZOOM_RANGE.min,
      zoomBy,
      panBy,
      reset,
    }),
    [panBy, pan.x, pan.y, reset, scale, zoomBy],
  );
}
