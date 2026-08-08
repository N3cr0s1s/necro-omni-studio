import {
  type FrameIndex,
  type FrameSpan,
  type TimelineDocument,
  endExclusive,
  frameIndex,
  framesToSecondsNumber,
  spanFromBounds,
} from '@nos/core';
import type { EffectSourceResolver, RenderPlan } from '@nos/compositor';
import { buildRenderPlan } from '@nos/compositor';
import type { ExportSettings } from '../contracts/export-settings.js';

/**
 * Export frame iteration and progress.
 *
 * The spec's WYSIWYG guarantee rests on export building **the same render plan** the preview builds, from
 * the same document, and running it through the same executor. This module is what makes that concrete:
 * it produces plans via `buildRenderPlan`, exactly as the preview loop does. There is deliberately no
 * export-specific plan builder, because a second one is precisely how the two paths would drift.
 *
 * What legitimately differs is only: the destination framebuffer, and the texture provider — export seeks
 * frame-exactly and may block for a decode, while preview drops a late frame to stay responsive.
 */

export type ExportPhase =
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'muxing'
  | 'complete'
  | 'cancelled'
  | 'failed';

export interface ExportProgress {
  readonly phase: ExportPhase;
  /** Frames written so far. */
  readonly framesDone: number;
  readonly framesTotal: number;
  /** `[0, 1]`. */
  readonly fraction: number;
  /** Rendered frames per second, averaged over the run. */
  readonly fps: number;
  /** Estimated seconds remaining, or `undefined` before there is enough data to say. */
  readonly remainingSeconds?: number;
  readonly message?: string;
}

export type ExportError =
  | { readonly kind: 'invalid-settings'; readonly detail: string }
  | { readonly kind: 'render-failed'; readonly frame: FrameIndex; readonly detail: string }
  | { readonly kind: 'encoder-failed'; readonly detail: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'sidecar-unavailable'; readonly detail: string };

export function describeExportError(error: ExportError): string {
  switch (error.kind) {
    case 'invalid-settings':
      return error.detail;
    case 'render-failed':
      return `Rendering failed at frame ${error.frame}: ${error.detail}`;
    case 'encoder-failed':
      return `The encoder failed: ${error.detail}`;
    case 'cancelled':
      return 'Export cancelled';
    case 'sidecar-unavailable':
      return `The media service is not available: ${error.detail}`;
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled export error ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Total frames an export will write. */
export function frameCountFor(range: FrameSpan): number {
  return range.duration;
}

/**
 * Yields every frame in the export range, in order.
 *
 * A generator rather than an array: a twenty-minute export at 60 fps is 72 000 frames, and materializing
 * that list before starting buys nothing. It also makes cancellation natural — the caller simply stops
 * iterating.
 */
export function* exportFrames(range: FrameSpan): Generator<FrameIndex> {
  const end = endExclusive(range);
  for (let frame: number = range.start; frame < end; frame += 1) {
    yield frameIndex(frame);
  }
}

/**
 * Builds the plan for one export frame.
 *
 * A thin wrapper over `buildRenderPlan` that exists to be *called* rather than to add behaviour — the
 * point is that export has no plan logic of its own. A test asserts it produces a plan identical to the
 * preview's for the same frame.
 */
export function planExportFrame(
  document: TimelineDocument,
  frame: FrameIndex,
  effects: EffectSourceResolver,
): RenderPlan {
  return buildRenderPlan({ document, frame, effects });
}

/**
 * Tracks progress across a run.
 *
 * Rate is measured over a trailing window rather than the whole run: export speed varies a great deal
 * between a title card and an eight-pass graded shot, and a whole-run average would give an estimate that
 * only becomes accurate once it no longer matters.
 */
export interface ProgressTracker {
  frameDone(atMs: number): void;
  setPhase(phase: ExportPhase, message?: string): void;
  snapshot(atMs: number): ExportProgress;
}

/** Frames averaged for the rate estimate. About a second of work at typical speeds. */
const RATE_WINDOW_FRAMES = 30;

export function createProgressTracker(framesTotal: number, startedAtMs: number): ProgressTracker {
  const recent: number[] = [];
  let framesDone = 0;
  let phase: ExportPhase = 'preparing';
  let message: string | undefined;
  let lastFrameAt = startedAtMs;

  return {
    frameDone(atMs: number): void {
      framesDone += 1;
      recent.push(atMs - lastFrameAt);
      if (recent.length > RATE_WINDOW_FRAMES) recent.shift();
      lastFrameAt = atMs;
    },

    setPhase(nextPhase: ExportPhase, nextMessage?: string): void {
      phase = nextPhase;
      message = nextMessage;
    },

    snapshot(atMs: number): ExportProgress {
      const elapsedMs = Math.max(1, atMs - startedAtMs);
      const averageMs =
        recent.length === 0
          ? 0
          : recent.reduce((total, value) => total + value, 0) / recent.length;
      const fps = averageMs > 0 ? 1000 / averageMs : (framesDone / elapsedMs) * 1000;

      const remaining = framesTotal - framesDone;
      // Withheld until a few frames are in: an estimate from one sample is noise, and a wildly wrong
      // first number is worse than none.
      const remainingSeconds =
        framesDone >= 3 && fps > 0 ? Math.round(remaining / fps) : undefined;

      return {
        phase,
        framesDone,
        framesTotal,
        fraction: framesTotal === 0 ? 0 : Math.min(1, framesDone / framesTotal),
        fps: Math.round(fps * 10) / 10,
        ...(remainingSeconds !== undefined ? { remainingSeconds } : {}),
        ...(message !== undefined ? { message } : {}),
      };
    },
  };
}

/** `about 2 min 30 s remaining` style text. */
export function formatRemaining(seconds: number | undefined): string {
  if (seconds === undefined) return 'estimating…';
  if (seconds < 60) return `about ${Math.max(1, seconds)} s remaining`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? `about ${minutes} min remaining`
    : `about ${minutes} min ${rest} s remaining`;
}

/**
 * The export range, honouring the in/out points.
 *
 * Falls back to the whole sequence, which is the same rule preview loop playback uses — one definition, so
 * "export the work range" and "loop the work range" cannot disagree.
 */
export function resolveExportRange(
  document: TimelineDocument,
  override?: FrameSpan,
): FrameSpan {
  if (override !== undefined) return override;
  const workRange = document.sequence.workRange;
  if (workRange !== undefined) return workRange;

  let end = 0;
  for (const track of document.sequence.tracks) {
    for (const clip of track.clips) {
      const clipEnd = endExclusive(clip.span);
      if (clipEnd > end) end = clipEnd;
    }
  }
  return spanFromBounds(frameIndex(0), frameIndex(end));
}

/** Duration of an export in seconds, for the size estimate and the dialog. */
export function exportDurationSeconds(settings: ExportSettings): number {
  // `framesToSecondsNumber` accepts either brand; passing the duration directly keeps the
  // position-versus-count distinction intact rather than casting one to the other.
  return framesToSecondsNumber(settings.range.duration, settings.frameRate);
}
