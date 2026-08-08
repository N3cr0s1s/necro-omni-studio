/**
 * Where a clip's strip image sits.
 *
 * A filmstrip covers a whole *asset*, but a clip shows a *range* of one — often a short range, and
 * rarely from the start. Stretching the asset's strip across the clip, or tiling it, puts pictures
 * under the wrong moments, which is worse than showing none: the strip is how an editor finds the
 * frame to cut on, so a plausible-looking wrong one costs more than a blank clip.
 *
 * Expressed in clip widths rather than pixels or seconds, because the clip's pixel width changes
 * with every zoom and the placement does not. One derivation per asset then serves every cut of it
 * at every zoom level — the component only has to divide.
 */
export interface ClipStrip {
  readonly url: string;
  /** How many clip widths the image spans. 1 means it was drawn for exactly this clip. */
  readonly widths: number;
  /** Where the image starts relative to the clip's left edge, in clip widths. Positive is left. */
  readonly offset: number;
}

/** A strip drawn for one clip specifically, as waveforms are. */
export function fittedStrip(url: string): ClipStrip {
  return { url, widths: 1, offset: 0 };
}

/**
 * A strip covering a whole asset, placed against the range one clip shows.
 *
 * Degenerate spans collapse to a fitted strip rather than dividing by zero: a clip of no length is
 * not something to draw a filmstrip for, and returning `Infinity` widths would blow up the layout
 * rather than show nothing.
 */
export function spanningStrip(
  url: string,
  coverage: { readonly sourceSeconds: number; readonly startSeconds: number; readonly shownSeconds: number },
): ClipStrip {
  if (coverage.shownSeconds <= 0 || coverage.sourceSeconds <= 0) return fittedStrip(url);
  return {
    url,
    widths: coverage.sourceSeconds / coverage.shownSeconds,
    offset: coverage.startSeconds / coverage.shownSeconds,
  };
}
