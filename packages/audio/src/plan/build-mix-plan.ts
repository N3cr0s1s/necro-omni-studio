import {
  type AudioClip,
  type AudioTrack,
  type FrameIndex,
  type FrameRate,
  type FrameSpan,
  type TimelineDocument,
  endExclusive,
  evaluateAt,
  frameIndex,
  framesToSecondsNumber,
  intersection,
  isAnimated,
  isTrackAudible,
  overlaps,
  spanFromBounds,
} from '@nos/core';
import type { GainPoint, MixPlan, MixSource } from '../contracts/mix-plan.js';

/**
 * Builds the mix plan for a time range.
 *
 * Pure: document and span in, plan out. Both playback and export use it, so an exported mix cannot
 * diverge from what was auditioned.
 *
 * Video clips contribute audio too — the spec has a video import produce a video clip with a *linked*
 * audio clip, so by the time a document exists the audio lives on audio tracks and this only has to walk
 * those. That keeps the rule simple: if you can see it on an audio track, you hear it.
 */

export interface BuildMixPlanOptions {
  readonly document: TimelineDocument;
  /** Range to plan, in project frames. */
  readonly span: FrameSpan;
  /**
   * Sample interval for gain automation, in frames.
   *
   * Keyframed gain becomes a series of scheduled ramps. Sampling rather than emitting one point per
   * keyframe is what makes eased curves audible as curves: a `ease-in-out` fade emitted as two points
   * would play as a straight line, since Web Audio ramps linearly between them.
   */
  readonly automationIntervalFrames?: number;
}

/** Default automation resolution: fine enough that an eased fade sounds smooth. */
export const DEFAULT_AUTOMATION_INTERVAL_FRAMES = 2;

export function buildMixPlan(options: BuildMixPlanOptions): MixPlan {
  const { document, span } = options;
  const rate = document.frameRate;
  const anySoloed = document.sequence.tracks.some((track) => track.solo);
  const automationInterval = Math.max(
    1,
    options.automationIntervalFrames ?? DEFAULT_AUTOMATION_INTERVAL_FRAMES,
  );

  const sources: MixSource[] = [];

  for (const track of document.sequence.tracks) {
    if (track.kind !== 'audio') continue;
    if (!isTrackAudible(track, anySoloed)) continue;

    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      // The audible part is the intersection of the clip with the planned range, so a clip straddling a
      // boundary is scheduled once per range with the right offset rather than restarted.
      const audible = intersection(clip.span, span);
      if (audible === undefined) continue;

      sources.push(buildSource(clip, track, audible, rate, automationInterval));
    }
  }

  return {
    span,
    startSeconds: framesToSecondsNumber(span.start, rate),
    endSeconds: framesToSecondsNumber(endExclusive(span), rate),
    sources,
  };
}

function buildSource(
  clip: AudioClip,
  track: AudioTrack,
  audible: FrameSpan,
  rate: FrameRate,
  automationInterval: number,
): MixSource {
  const clipRelativeStart = frameIndex(audible.start - clip.span.start);

  // Where in the file this range begins. The speed factor scales the offset, because at 2x a clip has
  // consumed twice as much source by the time it reaches the same timeline frame.
  const sourceInSeconds = framesToSecondsNumber(clip.source.sourceIn, clip.source.sourceRate);
  const elapsedSeconds = framesToSecondsNumber(clipRelativeStart, rate);
  const offsetSeconds = sourceInSeconds + elapsedSeconds * clip.speed.factor;

  // Gain at the start of the audible range. When the curve is animated this is the ramp's first value
  // and the automation points carry the rest; when it is constant this is the whole story.
  const startGain = evaluateAt(clip.gain, clipRelativeStart);

  return {
    clip: clip.id,
    track: track.id,
    asset: clip.source.asset,
    startSeconds: framesToSecondsNumber(audible.start, rate),
    durationSeconds: framesToSecondsNumber(audible.duration, rate),
    offsetSeconds,
    // Clip gain and track gain multiply. Clamped at zero because a negative gain would invert phase,
    // which is never what a fader below zero is meant to do.
    gain: Math.max(0, startGain) * Math.max(0, track.gain),
    pan: combinePan(evaluateAt(clip.pan, clipRelativeStart), track.pan),
    speed: clip.speed.factor,
    preservePitch: clip.speed.preservePitch,
    gainAutomation: isAnimated(clip.gain)
      ? sampleGainAutomation(clip, track, audible, rate, automationInterval)
      : [],
  };
}

/**
 * Combines clip and track pan.
 *
 * Summed and clamped rather than multiplied: panning a clip left on a track already panned left should
 * move further left, and multiplication would instead pull it back toward centre.
 */
function combinePan(clipPan: number, trackPan: number): number {
  const combined = (Number.isFinite(clipPan) ? clipPan : 0) + (Number.isFinite(trackPan) ? trackPan : 0);
  return Math.min(1, Math.max(-1, combined));
}

/**
 * Samples a keyframed gain curve into scheduled ramp points.
 *
 * The first and last points of the range are always included so the ramp starts and ends exactly on the
 * audible boundaries — otherwise a fade could begin a couple of frames late, which is audible on a
 * short one.
 */
function sampleGainAutomation(
  clip: AudioClip,
  track: AudioTrack,
  audible: FrameSpan,
  rate: FrameRate,
  intervalFrames: number,
): readonly GainPoint[] {
  const points: GainPoint[] = [];
  const trackGain = Math.max(0, track.gain);
  const lastFrame = endExclusive(audible);

  const emit = (frame: number): void => {
    const clipRelative = frameIndex(frame - clip.span.start);
    points.push({
      atSeconds: framesToSecondsNumber(frameIndex(frame), rate),
      gain: Math.max(0, evaluateAt(clip.gain, clipRelative)) * trackGain,
    });
  };

  for (let frame: number = audible.start; frame < lastFrame; frame += intervalFrames) {
    emit(frame);
  }
  // Guarantee an endpoint even when the range is not a whole number of intervals.
  const lastEmitted = points[points.length - 1];
  const endSeconds = framesToSecondsNumber(lastFrame, rate);
  if (lastEmitted === undefined || lastEmitted.atSeconds < endSeconds) {
    emit(lastFrame);
  }

  return points;
}

/**
 * The next planning range after a given one.
 *
 * The scheduler walks forward in fixed blocks. Fixed rather than clip-boundary-aligned because Web Audio
 * scheduling wants steady, predictable work per tick; a block that happens to contain twenty cuts is
 * still one block of scheduling.
 */
export function nextMixSpan(previous: FrameSpan, blockFrames: number): FrameSpan {
  const start = endExclusive(previous);
  return spanFromBounds(start, frameIndex(start + Math.max(1, blockFrames)));
}

/** Whether a document has anything audible at all, so playback can skip building a graph. */
export function hasAudibleContent(document: TimelineDocument): boolean {
  const anySoloed = document.sequence.tracks.some((track) => track.solo);
  return document.sequence.tracks.some(
    (track) =>
      track.kind === 'audio' &&
      isTrackAudible(track, anySoloed) &&
      track.clips.some((clip) => clip.enabled),
  );
}

/**
 * Clips audible exactly at one frame.
 *
 * Used by scrubbing, which needs "what is under the playhead right now" rather than a range.
 */
export function sourcesAtFrame(
  document: TimelineDocument,
  frame: FrameIndex,
): readonly MixSource[] {
  return buildMixPlan({
    document,
    span: spanFromBounds(frame, frameIndex(frame + 1)),
  }).sources;
}

/** Whether a span contains anything at all, so an empty block can skip scheduling. */
export function isSilent(plan: MixPlan): boolean {
  return plan.sources.length === 0 || plan.sources.every((source) => source.gain === 0);
}

/** Total simultaneous sources, so the engine can warn before exhausting node budgets. */
export function peakConcurrency(plan: MixPlan): number {
  const boundaries = new Set<number>();
  for (const source of plan.sources) {
    boundaries.add(source.startSeconds);
    boundaries.add(source.startSeconds + source.durationSeconds);
  }

  let peak = 0;
  for (const boundary of boundaries) {
    const active = plan.sources.filter(
      (source) =>
        source.startSeconds <= boundary && source.startSeconds + source.durationSeconds > boundary,
    ).length;
    if (active > peak) peak = active;
  }
  return peak;
}

/** Re-exported so callers can reason about overlap without importing core directly. */
export { overlaps };
