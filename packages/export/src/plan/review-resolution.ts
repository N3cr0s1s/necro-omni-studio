import type { Resolution } from '@nos/core';

/**
 * The size a review copy renders at.
 *
 * `useProxyResolution` was declared in the settings, defaulted to `false`, and warned about in the
 * dialog with a badge — and nothing set it and nothing acted on it. Its own documentation says why it
 * should exist: a review copy is a legitimate deliverable, and rendering one at full resolution wastes
 * minutes for a file nobody will grade.
 *
 * ## Why a short edge rather than a fraction
 *
 * Halving is the obvious rule and the wrong one: half of 4K is still 1080p, and half of 720p is a
 * thumbnail. Constraining the *short edge* is what the proxy pipeline already does, so a review export
 * and the proxies it reads from agree about size instead of resampling against each other — and it
 * behaves the same for portrait footage, which a width-based rule does not.
 */

/** Short edge of a review copy, matching the editing proxies so the two agree. */
export const REVIEW_SHORT_EDGE = 540;

/**
 * Scales a resolution down to the review short edge, preserving aspect.
 *
 * Returns the resolution **unchanged** when it is already at or below the target: upscaling a small
 * sequence to make a "smaller" review copy would cost more to encode and look worse, which is the
 * opposite of everything this is for.
 *
 * Both dimensions come back **even**. H.264 in yuv420p subsamples chroma by two, so an odd dimension
 * is either rejected outright by the encoder or silently padded — and a padded frame shifts the
 * picture by half a pixel against the preview, which is a WYSIWYG failure nobody would think to look
 * for in a review copy.
 */
export function reviewResolution(full: Resolution, shortEdge = REVIEW_SHORT_EDGE): Resolution {
  const smallest = Math.min(full.width, full.height);
  if (smallest <= 0 || shortEdge <= 0 || smallest <= shortEdge) return even(full);

  const scale = shortEdge / smallest;
  return even({
    width: Math.round(full.width * scale),
    height: Math.round(full.height * scale),
  });
}

/**
 * The resolution an export should actually render at.
 *
 * The one place the flag is interpreted, so the dialog's estimate and the renderer cannot disagree
 * about what a review copy costs — a preview of the file size computed from one resolution and a file
 * produced at another is worse than no estimate.
 */
export function exportResolution(
  full: Resolution,
  useProxyResolution: boolean,
  shortEdge = REVIEW_SHORT_EDGE,
): Resolution {
  return useProxyResolution ? reviewResolution(full, shortEdge) : even(full);
}

/** Rounds both dimensions down to even, never to zero. */
function even(resolution: Resolution): Resolution {
  return {
    width: Math.max(2, resolution.width - (resolution.width % 2)),
    height: Math.max(2, resolution.height - (resolution.height % 2)),
  };
}
