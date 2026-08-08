import { type MaskId, type TimelineDocument, clipId, locateClip, maskId } from '@nos/core';
import type { MaskSession } from '@nos/masks';
import type { MaskRegistration } from './media-textures.js';

/**
 * Where the preview looks up the mask an effect is bound to.
 *
 * The final link in the spec's §6.6, and the one that was missing: the segmenter produced masks, the
 * document could name one on an effect, the plan carried the id and the compositor asked for a
 * texture — and the renderer answered `undefined`, always. Every part of M11 worked except the part
 * that put a mask on the screen.
 *
 * ## Why a lookup rather than a map
 *
 * A propagated mask is one run-length array per frame of a clip — thousands of them for a minute of
 * video. Handing that whole set to the preview on every render, so it could pick one, would copy far
 * more than it read. `at(frame)` is asked for exactly what is about to be drawn.
 *
 * ## Why the id is derived
 *
 * A mask session belongs to a clip, so the id an effect stores has to be reconstructible from the clip
 * without consulting the session — otherwise a saved project would name a mask that only exists while
 * the segmentation panel is open. `maskIdForClip` is that rule, in one place, so the inspector writing
 * the binding and the preview resolving it cannot disagree.
 */

/** What the preview needs from whatever is holding masks. */
export interface MaskSource {
  /** The registrations for one frame: every bound mask, and the frame each resolves to. */
  at(frame: number): readonly MaskRegistration[];
}

/**
 * The id an effect stores to mean "the mask segmented for this clip".
 *
 * Derived rather than generated, because it has to survive a save: the session that produced the mask
 * is gone by the next launch, and a random id would leave the effect pointing at nothing.
 */
export function maskIdForClip(clip: string): MaskId {
  return maskId(`${clip}-mask`);
}

/**
 * Where on the timeline a clip begins, so a clip-relative mask frame can be found by an absolute one.
 *
 * Zero for no selection, which makes the source return nothing rather than reading the wrong frames.
 */
export function clipStartOf(document: TimelineDocument, clip: string | undefined): number {
  if (clip === undefined) return 0;
  return locateClip(document, clipId(clip))?.clip.span.start ?? 0;
}

/**
 * A source over the live segmentation session.
 *
 * Frames are clip-relative in the session and absolute on the timeline, which is the conversion this
 * exists to get right once: a mask propagated over frames 0–90 of a clip starting at frame 500 has to
 * be found at 500–590 while rendering.
 */
export function sessionMaskSource(session: MaskSession | undefined, clipStart: number): MaskSource {
  if (session === undefined) return { at: () => [] };

  const id = maskIdForClip(session.track.clip);
  return {
    at(frame) {
      // `undefined` rather than an omission: the registration says the id is bound and simply has no
      // coverage here, which is what releases the sampler instead of leaving the previous frame's
      // mask on screen.
      return [{ id, frame: session.frames.get(frame - clipStart) }];
    },
  };
}
