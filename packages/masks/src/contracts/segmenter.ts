import type { AssetPath, FrameIndex, FrameSpan, Result } from '@nos/core';
import type { MaskFrame, MaskPrompt } from './mask.js';

/**
 * The segmentation engine.
 *
 * An interface, not a SAM 2 client, for the same reason the generator framework has manifests: the model
 * will change, and nothing above this line should notice. A ComfyUI graph, a local `sam2` process or a
 * future model all satisfy it.
 *
 * The shape mirrors the job queue's deliberately: submit, watch progress, collect. Propagating a mask over
 * a few hundred frames takes as long as a generator run and competes for the same VRAM, so it goes through
 * the same GPU semaphore and needs the same cancellation story.
 */

export interface SegmentationRequest {
  /** The clip's media, project-relative. */
  readonly source: AssetPath;
  /** Frames to propagate over, in source frames. */
  readonly range: FrameSpan;
  /** Where the user clicked. At least one is required — an engine cannot guess the subject. */
  readonly prompts: readonly MaskPrompt[];
  /** Full-resolution mask size. Absent means the engine decides from the source. */
  readonly width?: number;
  readonly height?: number;
}

export interface SegmentationProgress {
  /** `[0, 1]`, or absent before the engine reports. */
  readonly fraction?: number;
  /** The frame just finished, so the UI can reveal masks as they arrive. */
  readonly frame?: FrameIndex;
  readonly stage?: string;
}

export type SegmentationError =
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'no-prompts' }
  | { readonly kind: 'source-missing'; readonly source: AssetPath }
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'cancelled' };

export interface SegmentationCapabilities {
  /** False when the engine cannot run, with `detail` saying why. Never hidden — always explained. */
  readonly available: boolean;
  readonly detail?: string;
  /** Model identifier, recorded with the mask so a re-run is reproducible. */
  readonly model?: string;
  /** Whether the engine can propagate, or only segment single frames. */
  readonly propagates: boolean;
}

export interface Segmenter {
  readonly id: string;
  capabilities(): Promise<SegmentationCapabilities>;
  /**
   * Segments and propagates.
   *
   * Yields progress and the frames as they land, so a long propagation is auditionable while it runs
   * rather than appearing all at once at the end.
   */
  run(request: SegmentationRequest, signal?: AbortSignal): AsyncIterable<SegmentationEvent>;
}

export type SegmentationEvent =
  | { readonly kind: 'progress'; readonly progress: SegmentationProgress }
  | { readonly kind: 'frame'; readonly mask: MaskFrame }
  | { readonly kind: 'done'; readonly result: Result<SegmentationSummary, SegmentationError> };

export interface SegmentationSummary {
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly model?: string;
}

/** A one-line reason, for the greyed-with-a-reason rule. */
export function describeSegmentationError(error: SegmentationError): string {
  switch (error.kind) {
    case 'unavailable':
      return `segmentation is unavailable: ${error.detail}`;
    case 'no-prompts':
      return 'click the object first — segmentation needs at least one point';
    case 'source-missing':
      return `the clip's media was not found at ${error.source}`;
    case 'failed':
      return error.detail;
    case 'cancelled':
      return 'cancelled';
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled error ${JSON.stringify(unreachable)}`);
    }
  }
}
