import type { FrameIndex, FrameSpan } from '@nos/core';
import { containsFrame, endExclusive, frameIndex, intersection, spanFromBounds } from '@nos/core';
import type { MaskFrame, MaskPrompt, MaskTrack } from '../contracts/mask.js';
import { withPrompt, withoutPrompt } from '../contracts/mask.js';
import type { SegmentationEvent, SegmentationRequest } from '../contracts/segmenter.js';
import { describeSegmentationError } from '../contracts/segmenter.js';

/**
 * The interactive segmentation session.
 *
 * The spec's interaction in model form: click the object on a frame, adjust the propagation range, run,
 * watch masks appear. Pure — no engine, no cache, no clock — so the whole interaction is testable and the
 * UI is a rendering of a value.
 *
 * The property worth stating: partial results are kept. A propagation that fails at frame 300 of 500 has
 * still produced 300 usable masks, and throwing them away because the run did not finish would waste the
 * expensive part of the work.
 */

export interface MaskSession {
  readonly track: MaskTrack;
  /** Where the user is looking, and where a click lands. */
  readonly frame: FrameIndex;
  /** Frames to propagate over. Starts as the clip's range and is narrowed by the range bar. */
  readonly propagation: FrameSpan;
  readonly frames: ReadonlyMap<number, MaskFrame>;
  readonly running: boolean;
  readonly progress?: number;
  readonly error?: string;
}

export function beginSession(track: MaskTrack, frame: FrameIndex): MaskSession {
  return {
    track,
    frame,
    propagation: track.range,
    frames: new Map(),
    running: false,
  };
}

/** Adds a click. The mask goes stale rather than re-running: propagation is far too expensive to autorun. */
export function addPrompt(session: MaskSession, prompt: MaskPrompt): MaskSession {
  return { ...session, track: withPrompt(session.track, prompt) };
}

export function removePrompt(session: MaskSession, index: number): MaskSession {
  const track = withoutPrompt(session.track, index);
  if (track === session.track) return session;
  return { ...session, track };
}

export function moveTo(session: MaskSession, frame: FrameIndex): MaskSession {
  return frame === session.frame ? session : { ...session, frame };
}

/**
 * Narrows the propagation range.
 *
 * Clamped to the track's range, because propagating outside the clip produces masks for frames the clip
 * never shows — pure cost, invisible result.
 */
export function setPropagation(session: MaskSession, span: FrameSpan): MaskSession {
  const clamped = intersection(session.track.range, span);
  if (clamped === undefined) return session;
  return { ...session, propagation: clamped };
}

/** The request an engine is given. `undefined` when there is nothing to segment yet. */
export function toRequest(session: MaskSession, source: SegmentationRequest['source']): SegmentationRequest | undefined {
  if (session.track.prompts.length === 0) return undefined;
  return { source, range: session.propagation, prompts: session.track.prompts };
}

/**
 * Folds one engine event into the session.
 *
 * A reducer rather than a subscription so the ordering rules — a frame arriving after a failure, a
 * progress event after `done` — are decided in one place and asserted in tests.
 */
export function applyEvent(session: MaskSession, event: SegmentationEvent): MaskSession {
  switch (event.kind) {
    case 'progress':
      return {
        ...session,
        running: true,
        ...(event.progress.fraction !== undefined ? { progress: event.progress.fraction } : {}),
      };

    case 'frame': {
      const frames = new Map(session.frames);
      frames.set(event.mask.frame, event.mask);
      return { ...session, frames, running: true, track: { ...session.track, status: 'pending' } };
    }

    case 'done': {
      if (event.result.ok) {
        return {
          ...session,
          running: false,
          progress: 1,
          track: { ...session.track, status: 'ready' },
        };
      }
      return {
        ...session,
        running: false,
        error: describeSegmentationError(event.result.error),
        // Partial results are kept: 300 of 500 frames is 300 frames of expensive work.
        track: {
          ...session.track,
          status: session.frames.size > 0 ? 'stale' : 'failed',
          error: describeSegmentationError(event.result.error),
        },
      };
    }

    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Marks the session as started, clearing the previous run's error but keeping its frames. */
export function beginRun(session: MaskSession): MaskSession {
  const next: MaskSession = {
    ...session,
    running: true,
    progress: 0,
    track: { ...session.track, status: 'pending' },
  };
  const { error: _dropped, ...withoutError } = next;
  return withoutError;
}

/** The mask to show on a frame, or `undefined` where propagation has not reached. */
export function maskAt(session: MaskSession, frame: FrameIndex): MaskFrame | undefined {
  return session.frames.get(frame);
}

/** Frames covered so far, as spans, for drawing the propagation bar. */
export function coveredSpans(session: MaskSession): readonly FrameSpan[] {
  const frames = [...session.frames.keys()].sort((a, b) => a - b);
  const spans: FrameSpan[] = [];

  let runStart: number | undefined;
  let previous: number | undefined;

  for (const frame of frames) {
    if (runStart === undefined || previous === undefined) {
      runStart = frame;
    } else if (frame !== previous + 1) {
      spans.push(spanFromBounds(frameIndex(runStart), frameIndex(previous + 1)));
      runStart = frame;
    }
    previous = frame;
  }
  if (runStart !== undefined && previous !== undefined) {
    spans.push(spanFromBounds(frameIndex(runStart), frameIndex(previous + 1)));
  }
  return spans;
}

/** Fraction of the propagation range that has a mask. */
export function coverage(session: MaskSession): number {
  const total = session.propagation.duration;
  if (total <= 0) return 0;

  let covered = 0;
  for (const frame of session.frames.keys()) {
    if (containsFrame(session.propagation, frameIndex(frame))) covered += 1;
  }
  return covered / total;
}

/** The last frame the propagation covers, for the range bar's right handle. */
export function propagationEnd(session: MaskSession): FrameIndex {
  return endExclusive(session.propagation);
}

/** One line describing the session, so the wording is asserted once. */
export function describeSession(session: MaskSession): string {
  if (session.error !== undefined) return session.error;
  if (session.running) {
    return session.progress === undefined
      ? 'segmenting'
      : `segmenting ${Math.round(session.progress * 100)}%`;
  }
  if (session.track.prompts.length === 0) return 'click the object to start';
  if (session.frames.size === 0) return 'ready to segment';
  if (session.track.status === 'stale') return 'prompts changed — re-run to update';
  return `${session.frames.size} frames masked`;
}
