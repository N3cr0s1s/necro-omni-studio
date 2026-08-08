import type { EffectRegistry } from '@nos/effects';
import type { FrameIndex, TimelineDocument } from '@nos/core';
import { type RenderPlan, buildRenderPlan } from '@nos/compositor';
import type { MediaTextures, TextRasterProblem } from './media-textures.js';
import type { MaskSource } from './mask-source.js';
import { textCacheKeyFor, textClipsOf } from './text-plan.js';

/**
 * Everything that has to happen before one frame can be drawn.
 *
 * The spec's §6.7 makes a WYSIWYG guarantee, and rests it on there being a single compositor. That is
 * necessary and it was not sufficient: the preview and the export each built their own plan and
 * prepared the registry their own way, and they had drifted apart in two places at once.
 *
 * - The export called `buildRenderPlan` **without** `textCacheKey`, so its text layers were keyed by
 *   clip id while the rasterizer stored them by content hash, and it never called `registerText` at
 *   all. Both faults point the same way: `textTexture` found nothing, the layer drew nothing, and
 *   **every title was silently absent from every delivered file.** The preview showed it. The
 *   guarantee is precisely that this cannot happen.
 * - The export never registered masks either, so a masked effect exported unmasked.
 *
 * Fixing the two call sites would have fixed the two bugs. One function they both go through is what
 * makes a third of the same kind impossible: there is now nowhere for the export to be *different*
 * from the preview, because there is only one description of what a frame needs.
 *
 * The one thing they may legitimately differ on is `wait`, and it stays a parameter for the reason it
 * always had: a skipped layer in a preview is a momentary blank, and in a delivered file it is a
 * missing shot.
 */

export interface FrameRequest {
  readonly document: TimelineDocument;
  readonly frame: FrameIndex;
  readonly effects: EffectRegistry;
  /** Where a bound mask's frame comes from. Absent leaves every mask slot unbound. */
  readonly masks?: MaskSource | undefined;
  /**
   * Whether to block until every source has reached its frame.
   *
   * False for the preview, where blocking on a seek turns a slow decode into a frozen window. True for
   * an export, where a skipped layer is a hole in the result.
   */
  readonly wait?: boolean | undefined;
}

export interface PreparedFrame {
  readonly plan: RenderPlan;
  /** Titles that could not be rasterized, so a caller can say so rather than showing a blank. */
  readonly textProblems: readonly TextRasterProblem[];
}

/**
 * Builds the plan for a frame and brings the registry to it.
 *
 * The order matters and is not obvious. Masks are registered *before* the render reads them and are
 * frame-indexed, so they are set from the request rather than looked up later. Text is rasterized
 * before `prepare`, because a raster that has not landed is a texture the plan will ask for and not
 * find — and unlike a video frame, it will never arrive on its own.
 */
export async function prepareFrame(media: MediaTextures, request: FrameRequest): Promise<PreparedFrame> {
  const { document, frame, effects, masks, wait } = request;

  const plan = buildRenderPlan({
    document,
    frame,
    effects,
    // The key that binds a plan's text layer to the raster made for it. Omitting it was half of the
    // export's missing titles: the plan then names clips and the rasterizer stores content hashes.
    textCacheKey: textCacheKeyFor(document.resolution),
  });

  media.registerMasks(masks === undefined ? [] : masks.at(frame));

  // Cheap after the first frame: rasters are cached by content hash, so this is a map lookup per text
  // clip for the rest of an export rather than a re-rasterization.
  const textProblems = await media.registerText(textClipsOf(document), document.resolution);
  await media.prepare(plan.items, wait === true ? { wait: true } : {});

  return { plan, textProblems };
}
