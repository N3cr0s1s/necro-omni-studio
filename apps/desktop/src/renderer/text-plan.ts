import { type Resolution, type TextClip, type TimelineDocument } from '@nos/core';
import { contentCacheKey } from '@nos/text';

/**
 * The bridge between text clips and the render plan.
 *
 * The plan carries a **cache key**, not a font or a string: that is what keeps the compositor ignorant
 * of typography, and it is why the key has to be computed here, from the same content the rasterizer
 * will use. One definition, so a mismatch between what is rasterized and what is looked up is not
 * expressible.
 */

/** Wrapping width for a title. Nine tenths of the frame, so a full-width line still has a margin. */
export function textMaxWidth(resolution: Resolution): number {
  return Math.max(16, Math.round(resolution.width * 0.9));
}

/** Every text clip in the document, for registering rasters before a render. */
export function textClipsOf(document: TimelineDocument): readonly TextClip[] {
  return document.sequence.tracks.flatMap((track) =>
    track.kind === 'text' ? (track.clips as readonly TextClip[]) : [],
  );
}

/** The plan's `textCacheKey`, matching what `registerText` stores under. */
export function textCacheKeyFor(resolution: Resolution) {
  return (clip: { readonly kind: string }): string => {
    const text = clip as TextClip;
    return contentCacheKey(text.content, textMaxWidth(resolution));
  };
}
