import {
  type ClipId,
  type SelectionRegion,
  type TimelineDocument,
  linkedPartner,
  overlaps,
  trackClips,
} from '@nos/core';

/**
 * Which clips a gesture selects.
 *
 * Selection had been one clip at a time, or several by shift-clicking each — which made every
 * multi-clip operation that now exists (copy, delete, disable) technically reachable and practically
 * not: nobody shift-clicks eleven clips to move a scene.
 *
 * Pure, and separate from the timeline component, because "which clips does this rectangle touch"
 * is a question about the *document* and not about pixels. The component converts a drag to a frame
 * span and a set of tracks; everything after that is here, where it can be reasoned about.
 */

/**
 * Clips a region touches.
 *
 * **Intersection, not containment.** A rectangle dragged across the middle of a scene selects the
 * clips it crosses, including the long one whose ends are off screen — requiring a clip to be wholly
 * inside would make selecting a long clip impossible at any useful zoom, which is precisely when a
 * user reaches for a marquee.
 */
export function clipsInRegion(document: TimelineDocument, region: SelectionRegion): readonly ClipId[] {
  const wanted = new Set<string>(region.tracks as readonly string[]);
  const found: ClipId[] = [];

  for (const track of document.sequence.tracks) {
    if (!wanted.has(track.id)) continue;
    for (const clip of trackClips(track)) {
      if (overlaps(clip.span, region.span)) found.push(clip.id);
    }
  }
  return found;
}

/** Every clip on the timeline, for a select-all. */
export function allClips(document: TimelineDocument): readonly ClipId[] {
  return document.sequence.tracks.flatMap((track) => trackClips(track).map((clip) => clip.id));
}

/**
 * Combines a marquee's result with what was already selected.
 *
 * Additive when a modifier is held, replacing otherwise — the convention every list and canvas
 * shares, and the only one where a user can build a selection up without starting over each time.
 * Adding is *union*, never toggle: a marquee dragged over something already selected should not
 * quietly remove it, which is what a toggle would do to any clip caught by both drags.
 */
export function combineSelection(
  current: ReadonlySet<string>,
  found: readonly ClipId[],
  additive: boolean,
): ReadonlySet<string> {
  if (!additive) return new Set(found as readonly string[]);
  const next = new Set(current);
  for (const clip of found) next.add(clip);
  return next;
}

/**
 * Clips linked to the ones selected.
 *
 * A video clip and the audio split out of the same file are one thing to a user, so an operation on
 * either should reach both. Kept as a separate step rather than folded into the region search: the
 * link matters for *editing*, and a marquee that silently reached onto a track it never crossed
 * would be harder to reason about than one that did not.
 */
export function withLinkedClips(document: TimelineDocument, selected: readonly ClipId[]): readonly ClipId[] {
  const result = new Set<string>(selected as readonly string[]);

  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      if (!result.has(clip.id)) continue;
      const partner = linkedPartner(clip);
      if (partner !== undefined) result.add(partner);
    }
  }
  return [...result] as ClipId[];
}
