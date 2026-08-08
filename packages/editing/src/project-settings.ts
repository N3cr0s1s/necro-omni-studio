import {
  type AnimatableNumber,
  type Clip,
  type FrameRate,
  type FrameSpan,
  type Keyframe,
  type Resolution,
  type Result,
  type TimelineDocument,
  type Track,
  convertDurationCeil,
  convertFrames,
  frameIndex,
  frameRateEquals,
  framesToSeconds,
  multiply,
  ok,
  trackClips,
} from '@nos/core';
import type { EditError } from './errors.js';

/**
 * Changing a project's rate and resolution.
 *
 * The document has carried both since M1 and neither could be changed after the project was created:
 * a sequence started at 30 fps stayed at 30 fps forever, which is a decision most editors make *after*
 * seeing their material rather than before.
 *
 * Rate is the difficult half. Every time in the document — clip spans, keyframe positions, markers,
 * the in/out range — is a **frame index at the project rate**, so changing the rate without touching
 * them would silently retime the whole programme: a cut two seconds in at 24 fps would land at 1.6
 * seconds at 30. Everything is therefore rebased through the time layer's exact conversion.
 *
 * Resolution is the easy half and stays that way because transforms are normalized to `[0, 1]` of the
 * output — a resolution change moves nothing.
 */

export interface ProjectSettings {
  readonly frameRate: FrameRate;
  readonly resolution: Resolution;
}

/**
 * How lossy a rate change is.
 *
 * Reported rather than hidden, because it is a real cost and an irreversible one: converting 30 → 24
 * and back does not return the original frame positions, so a user deserves to know before rather
 * than after. Counted as the number of *timed things* that will not land on an exact frame.
 */
export interface RetimeCost {
  readonly from: FrameRate;
  readonly to: FrameRate;
  /** Positions that will be rounded, out of everything the document times. */
  readonly rounded: number;
  readonly total: number;
}

/** Whether a rate change would move anything at all. */
export function retimeCost(document: TimelineDocument, to: FrameRate): RetimeCost {
  const from = document.frameRate;
  let rounded = 0;
  let total = 0;

  const check = (position: number): void => {
    total += 1;
    if (frameRateEquals(from, to)) return;
    // Measured on the exact rational rather than by converting and back: frame 1 at 30 fps becomes
    // 0.8 of a frame at 24, which rounds to 1 and then converts back to 1 — a round trip that looks
    // lossless while the position has in fact been moved.
    const exact = multiply(framesToSeconds(frameIndex(position), from), to.value);
    if (exact.numerator % exact.denominator !== 0) rounded += 1;
  };

  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      check(clip.span.start);
      check(clip.span.duration);
      for (const keyframe of keyframesOf(clip)) check(keyframe.frame);
    }
  }
  for (const marker of document.sequence.markers) check(marker.frame);
  if (document.sequence.workRange !== undefined) check(document.sequence.workRange.start);

  return { from, to, rounded, total };
}

/**
 * Applies new settings, rebasing every time in the document.
 *
 * Durations round **up** and positions round to nearest, which is the pairing that keeps a clip from
 * losing its tail: a duration rounded down would shorten material, where a start rounded to the
 * nearest frame moves it by at most half a frame in either direction.
 */
export function applyProjectSettings(
  document: TimelineDocument,
  settings: ProjectSettings,
): Result<TimelineDocument, EditError> {
  const from = document.frameRate;
  const to = settings.frameRate;

  const resized: TimelineDocument = {
    ...document,
    resolution: settings.resolution,
    frameRate: to,
  };
  if (frameRateEquals(from, to)) return ok(resized);

  const tracks = document.sequence.tracks.map((track) => retimeTrack(track, from, to));
  const workRange = document.sequence.workRange;

  return ok({
    ...resized,
    sequence: {
      ...document.sequence,
      tracks,
      markers: document.sequence.markers.map((marker) => ({
        ...marker,
        frame: convertFrames(marker.frame, from, to),
      })),
      ...(workRange !== undefined ? { workRange: retimeSpan(workRange, from, to) } : {}),
    },
  });
}

function retimeTrack(track: Track, from: FrameRate, to: FrameRate): Track {
  return withRetimedClips(
    track,
    trackClips(track).map((clip) => retimeClip(clip, from, to)),
  );
}

function retimeClip(clip: Clip, from: FrameRate, to: FrameRate): Clip {
  const retimed = {
    ...clip,
    span: retimeSpan(clip.span, from, to),
    effects: clip.effects.map((instance) => ({
      ...instance,
      params: Object.fromEntries(
        Object.entries(instance.params).map(([key, value]) => [key, retimeParam(value, from, to)]),
      ),
    })),
  } as Clip;

  // The source's own rate is untouched. It describes the *file*, not the timeline, and rebasing it
  // would make every frame read from the wrong place — the one conversion this must not do.
  if (retimed.kind === 'text') {
    return retimed.reveal === undefined
      ? retimed
      : { ...retimed, reveal: retimeParam(retimed.reveal, from, to) };
  }
  if (retimed.kind === 'audio') {
    return {
      ...retimed,
      gain: retimeParam(retimed.gain, from, to),
      pan: retimeParam(retimed.pan, from, to),
    };
  }
  return {
    ...retimed,
    transform: Object.fromEntries(
      Object.entries(retimed.transform).map(([key, value]) => [key, retimeParam(value, from, to)]),
    ) as typeof retimed.transform,
  };
}

function retimeSpan(span: FrameSpan, from: FrameRate, to: FrameRate): FrameSpan {
  return {
    start: convertFrames(span.start, from, to),
    // Ceiling, so a converted clip never loses its tail.
    duration: convertDurationCeil(span.duration, from, to),
  };
}

function retimeParam<T>(value: T, from: FrameRate, to: FrameRate): T {
  const param = value as unknown as AnimatableNumber;
  if (param === null || typeof param !== 'object' || param.kind !== 'animated') return value;

  return {
    ...param,
    keyframes: param.keyframes.map((keyframe: Keyframe) => ({
      ...keyframe,
      frame: convertFrames(keyframe.frame, from, to),
    })),
  } as unknown as T;
}

function keyframesOf(clip: Clip): readonly Keyframe[] {
  const params: AnimatableNumber[] = [];
  for (const instance of clip.effects) {
    for (const value of Object.values(instance.params)) params.push(value as AnimatableNumber);
  }
  if (clip.kind === 'audio') params.push(clip.gain, clip.pan);
  else if (clip.kind === 'text') {
    if (clip.reveal !== undefined) params.push(clip.reveal);
    params.push(...Object.values(clip.transform));
  } else params.push(...Object.values(clip.transform));

  return params.flatMap((param) => (param.kind === 'animated' ? param.keyframes : []));
}

/** Writes clips back, keeping the track's kind. */
function withRetimedClips(track: Track, clips: readonly Clip[]): Track {
  return { ...track, clips } as Track;
}
