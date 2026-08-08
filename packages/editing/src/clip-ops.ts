import {
  type Clip,
  type ClipId,
  type FrameIndex,
  type FrameRate,
  type FrameSpan,
  type MediaSource,
  type Result,
  type TimelineDocument,
  type Track,
  type TrackId,
  TRACK_ACCEPTS,
  clipTransform,
  endExclusive,
  err,
  frameIndex,
  framesToSeconds,
  isEmpty,
  ok,
  overlaps,
  secondsToFrames,
  shiftKeyframes,
  spanFromBounds,
  split as splitSpan,
  subtractSpan,
  trackClips,
} from '@nos/core';
import type { EditError } from './errors.js';
import {
  addClipToTrack,
  assertUnlocked,
  findTrackOrFail,
  locateClipOrFail,
  removeClipFromTrack,
  replaceClip,
  replaceTrack,
  withClips,
} from './mutate.js';

/**
 * Clip editing operations.
 *
 * Every function is a pure `TimelineDocument -> Result<TimelineDocument, EditError>`. No operation
 * mutates its input, none performs I/O, and none knows about the UI. That is what allows the whole
 * set to be composed inside one `store.transaction()` and collapse to a single undo step.
 */

/**
 * How much source material a clip has behind it.
 *
 * Trimming is the one operation that cannot be decided from the document alone: whether a tail trim
 * is legal depends on how many frames the underlying file actually holds. That lives in probe
 * metadata, so it is injected rather than assumed.
 */
export interface SourceBounds {
  /** Total frames in the source, at the source's own rate. */
  readonly totalFrames: number;
}

/**
 * Supplies source limits for a clip.
 *
 * An interface, not a map, because the caller may resolve bounds lazily from a metadata cache. When
 * it returns `undefined` the trim proceeds unchecked — better to allow an edit that a later reload
 * corrects than to block editing because a probe has not finished.
 */
export interface SourceBoundsResolver {
  boundsFor(clip: Clip): SourceBounds | undefined;
}

/** Resolver that knows nothing, for tests and for editing before probes land. */
export const UNBOUNDED_SOURCES: SourceBoundsResolver = { boundsFor: () => undefined };

export interface EditOptions {
  readonly sources?: SourceBoundsResolver;
}

/** Converts a project-rate frame count to the equivalent count at a source's rate. */
function toSourceFrames(count: number, projectRate: FrameRate, sourceRate: FrameRate): number {
  if (count === 0) return 0;
  const seconds = framesToSeconds(frameIndex(count), projectRate);
  return secondsToFrames(seconds, sourceRate);
}

function clipKind(clip: Clip): string {
  return clip.kind;
}

function assertAccepts(track: Track, clip: Clip): Result<Track, EditError> {
  const accepted = TRACK_ACCEPTS[track.kind];
  if (accepted.includes(clip.kind)) return ok(track);
  return err({
    kind: 'wrong-track-kind',
    track: track.id,
    accepts: accepted,
    received: clipKind(clip),
  });
}

function firstCollision(track: Track, span: FrameSpan, ignore?: ClipId): ClipId | undefined {
  for (const clip of trackClips(track)) {
    if (clip.id === ignore) continue;
    if (overlaps(clip.span, span)) return clip.id;
  }
  return undefined;
}

/**
 * Splits a clip at an absolute frame — the razor tool.
 *
 * The right-hand piece needs a new id and its source in-point advanced by the cut offset, converted
 * to the source's rate. Its keyframes shift back by the same offset, because keyframe positions are
 * clip-relative: without the shift, an effect animation would jump when a clip is cut in half.
 */
export function splitClip(
  document: TimelineDocument,
  clipId: ClipId,
  at: FrameIndex,
  newClipId: ClipId,
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;

  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;

  const { track, clip } = located.value;
  const halves = splitSpan(clip.span, at);
  if (halves === undefined) {
    // On or outside a boundary. A no-op rather than an error: clicking the razor on a clip edge is
    // a natural miss, and producing a zero-length clip would be worse than doing nothing.
    return err({ kind: 'nothing-to-cut', track: track.id });
  }

  const [leftSpan, rightSpan] = halves;
  const offset = at - clip.span.start;

  const left: Clip = { ...clip, span: leftSpan };
  const right: Clip = {
    ...shiftClipKeyframes(clip, -offset),
    id: newClipId,
    span: rightSpan,
    ...(clip.kind === 'text' ? {} : { source: advanceSource(clip.source, offset, document.frameRate) }),
  } as Clip;

  const withLeft = replaceClip(track, left);
  return ok(replaceTrack(document, addClipToTrack(withLeft, right)));
}

function advanceSource(source: MediaSource, offset: number, projectRate: FrameRate): MediaSource {
  return {
    ...source,
    sourceIn: frameIndex(source.sourceIn + toSourceFrames(offset, projectRate, source.sourceRate)),
  };
}

/**
 * Shifts every keyframe on a clip, including those on its effect parameters.
 *
 * Applied on a head trim and on the right half of a split. Keyframes are clip-relative, so moving a
 * clip's in-point without moving them would slide every effect animation against the picture.
 */
function shiftClipKeyframes(clip: Clip, delta: number): Clip {
  if (delta === 0) return clip;

  const effects = clip.effects.map((effect) => ({
    ...effect,
    params: Object.fromEntries(
      Object.entries(effect.params).map(([key, value]) => [
        key,
        value.kind === 'static' || value.kind === 'animated' ? shiftKeyframes(value, delta) : value,
      ]),
    ),
  }));

  const transform = clipTransform(clip);
  const shiftedTransform =
    transform === undefined
      ? undefined
      : {
          x: shiftKeyframes(transform.x, delta),
          y: shiftKeyframes(transform.y, delta),
          scale: shiftKeyframes(transform.scale, delta),
          rotation: shiftKeyframes(transform.rotation, delta),
          opacity: shiftKeyframes(transform.opacity, delta),
        };

  return {
    ...clip,
    effects,
    ...(shiftedTransform === undefined ? {} : { transform: shiftedTransform }),
    ...(clip.kind === 'audio'
      ? { gain: shiftKeyframes(clip.gain, delta), pan: shiftKeyframes(clip.pan, delta) }
      : {}),
    ...(clip.kind === 'text' && clip.reveal !== undefined
      ? { reveal: shiftKeyframes(clip.reveal, delta) }
      : {}),
  } as Clip;
}

/**
 * Cuts every unlocked track at a frame — the "cut all" razor.
 *
 * Locked tracks are skipped silently rather than failing the whole operation: the user asked to cut
 * the timeline, and refusing because one layer is locked would be unhelpful when skipping is exactly
 * what locking means.
 */
export function splitAllTracksAt(
  document: TimelineDocument,
  at: FrameIndex,
  idFactory: () => ClipId,
): Result<TimelineDocument, EditError> {
  let current = document;
  let cutAny = false;

  for (const track of document.sequence.tracks) {
    if (track.locked) continue;
    for (const clip of trackClips(track)) {
      if (at <= clip.span.start || at >= endExclusive(clip.span)) continue;
      const result = splitClip(current, clip.id, at, idFactory());
      if (result.ok) {
        current = result.value;
        cutAny = true;
      }
    }
  }

  return cutAny ? ok(current) : err({ kind: 'nothing-to-cut', track: '' as TrackId });
}

/**
 * Moves a clip's in-point, keeping its out-point — a head trim.
 *
 * A positive delta shortens the clip. The source in-point advances with it so the same source frames
 * stay under the same timeline frames, and keyframes shift so effects stay glued to the picture.
 *
 * Takes no `SourceBoundsResolver`: extending the head backwards is limited by the clip's own
 * `sourceIn` — the frames before it — which the document already knows. Only a *tail* extension needs
 * to ask how long the source actually is.
 */
export function trimClipStart(
  document: TimelineDocument,
  clipId: ClipId,
  delta: number,
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;
  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;

  const { track, clip } = located.value;
  const end = endExclusive(clip.span);
  const nextStart = frameIndex(clip.span.start + delta);

  if (nextStart >= end) return err({ kind: 'empty-result', clip: clipId });

  // Trimming the head backwards needs source material *before* the current in-point.
  if (clip.kind !== 'text' && delta < 0) {
    const sourceDelta = toSourceFrames(-delta, document.frameRate, clip.source.sourceRate);
    if (clip.source.sourceIn - sourceDelta < 0) {
      return err({
        kind: 'source-exhausted',
        clip: clipId,
        available: clip.source.sourceIn,
        requested: sourceDelta,
      });
    }
  }

  const collision = firstCollision(track, spanFromBounds(nextStart, end), clipId);
  if (collision !== undefined) {
    return err({ kind: 'collision', track: track.id, withClip: collision });
  }

  const shifted = shiftClipKeyframes(clip, -delta);
  const next: Clip = {
    ...shifted,
    span: spanFromBounds(nextStart, end),
    ...(clip.kind === 'text' ? {} : { source: advanceSource(clip.source, delta, document.frameRate) }),
  } as Clip;

  return ok(replaceTrack(document, replaceClip(track, next)));
}

/**
 * Moves a clip's out-point, keeping its in-point — a tail trim.
 *
 * Does not touch the source in-point or keyframes. Extending needs source material beyond the
 * current out-point, which is the check that needs `SourceBounds`.
 */
export function trimClipEnd(
  document: TimelineDocument,
  clipId: ClipId,
  delta: number,
  options: EditOptions = {},
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;
  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;

  const { track, clip } = located.value;
  const nextEnd = frameIndex(endExclusive(clip.span) + delta);

  if (nextEnd <= clip.span.start) return err({ kind: 'empty-result', clip: clipId });

  if (clip.kind !== 'text' && delta > 0) {
    const bounds = options.sources?.boundsFor(clip);
    if (bounds !== undefined) {
      const requestedFrames = nextEnd - clip.span.start;
      const requestedSource = toSourceFrames(requestedFrames, document.frameRate, clip.source.sourceRate);
      const available = bounds.totalFrames - clip.source.sourceIn;
      if (requestedSource > available) {
        return err({
          kind: 'source-exhausted',
          clip: clipId,
          available,
          requested: requestedSource,
        });
      }
    }
  }

  const collision = firstCollision(track, spanFromBounds(clip.span.start, nextEnd), clipId);
  if (collision !== undefined) {
    return err({ kind: 'collision', track: track.id, withClip: collision });
  }

  const next: Clip = { ...clip, span: spanFromBounds(clip.span.start, nextEnd) };
  return ok(replaceTrack(document, replaceClip(track, next)));
}

/**
 * Slips a clip: changes which source frames play, without moving the clip.
 *
 * Keyframes deliberately do *not* move. Slip changes the content behind a fixed window, and an effect
 * animation is authored against the window, not against the material — a fade-in should still be at
 * the clip's start after slipping.
 */
export function slipClip(
  document: TimelineDocument,
  clipId: ClipId,
  delta: number,
  options: EditOptions = {},
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;
  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;

  const { track, clip } = located.value;
  if (clip.kind === 'text') return ok(document);
  if (delta === 0) return ok(document);

  const sourceDelta = toSourceFrames(Math.abs(delta), document.frameRate, clip.source.sourceRate);
  const signedDelta = delta > 0 ? sourceDelta : -sourceDelta;
  const nextIn = clip.source.sourceIn + signedDelta;

  if (nextIn < 0) {
    return err({
      kind: 'source-exhausted',
      clip: clipId,
      available: clip.source.sourceIn,
      requested: sourceDelta,
    });
  }

  const bounds = options.sources?.boundsFor(clip);
  if (bounds !== undefined) {
    const lengthInSource = toSourceFrames(clip.span.duration, document.frameRate, clip.source.sourceRate);
    if (nextIn + lengthInSource > bounds.totalFrames) {
      return err({
        kind: 'source-exhausted',
        clip: clipId,
        available: bounds.totalFrames - nextIn,
        requested: lengthInSource,
      });
    }
  }

  const next: Clip = {
    ...clip,
    source: { ...clip.source, sourceIn: frameIndex(nextIn) },
  } as Clip;
  return ok(replaceTrack(document, replaceClip(track, next)));
}

/**
 * Moves a clip to a position, optionally to a different track.
 *
 * Rejects a collision rather than pushing neighbours aside. Silently displacing material the user
 * cannot see is the single most destructive thing a timeline can do; the UI shows the rejection and
 * the drag snaps back.
 */
export function moveClip(
  document: TimelineDocument,
  clipId: ClipId,
  targetTrackId: TrackId,
  newStart: FrameIndex,
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;

  const sourceUnlocked = assertUnlocked(located.value.track);
  if (!sourceUnlocked.ok) return sourceUnlocked;

  const targetResult = findTrackOrFail(document, targetTrackId);
  if (!targetResult.ok) return targetResult;

  const targetUnlocked = assertUnlocked(targetResult.value);
  if (!targetUnlocked.ok) return targetUnlocked;

  const { clip } = located.value;
  const accepts = assertAccepts(targetResult.value, clip);
  if (!accepts.ok) return accepts;

  if (newStart < 0) return err({ kind: 'empty-result', clip: clipId });

  const nextSpan = spanFromBounds(newStart, frameIndex(newStart + clip.span.duration));
  const sameTrack = located.value.track.id === targetTrackId;
  const collision = firstCollision(targetResult.value, nextSpan, sameTrack ? clipId : undefined);
  if (collision !== undefined) {
    return err({ kind: 'collision', track: targetTrackId, withClip: collision });
  }

  const moved: Clip = { ...clip, span: nextSpan };

  if (sameTrack) {
    return ok(replaceTrack(document, replaceClip(located.value.track, moved)));
  }

  const withoutClip = removeClipFromTrack(located.value.track, clipId);
  const intermediate = replaceTrack(document, withoutClip);
  const freshTarget = findTrackOrFail(intermediate, targetTrackId);
  if (!freshTarget.ok) return freshTarget;
  return ok(replaceTrack(intermediate, addClipToTrack(freshTarget.value, moved)));
}

/** Removes a clip, leaving a gap — "lift". */
export function liftClip(document: TimelineDocument, clipId: ClipId): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;
  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;

  return ok(replaceTrack(document, removeClipFromTrack(located.value.track, clipId)));
}

/**
 * Removes a clip and closes the gap by pulling later clips on the same track back.
 *
 * Scoped to one track by design. Rippling every track would desynchronize layers that were aligned
 * deliberately — the same reasoning the spec applies to discovered-length inserts, where a narration
 * must never rearrange the video cut.
 */
export function rippleDeleteClip(
  document: TimelineDocument,
  clipId: ClipId,
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;
  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;

  const { track, clip } = located.value;
  const gap = clip.span.duration;
  const removedEnd = endExclusive(clip.span);

  const remaining = trackClips(track)
    .filter((candidate) => candidate.id !== clipId)
    .map((candidate) =>
      candidate.span.start >= removedEnd
        ? {
            ...candidate,
            span: spanFromBounds(
              frameIndex(candidate.span.start - gap),
              frameIndex(endExclusive(candidate.span) - gap),
            ),
          }
        : candidate,
    );

  return ok(replaceTrack(document, withClips(track, remaining)));
}

/**
 * Removes a frame range from a track, splitting clips that straddle its edges, then closes the gap.
 *
 * This is the range-based ripple delete: the user marks in/out and removes that section. Clips fully
 * inside vanish; clips overlapping an edge keep their surviving piece.
 */
export function rippleDeleteRange(
  document: TimelineDocument,
  trackId: TrackId,
  range: FrameSpan,
  idFactory: () => ClipId,
): Result<TimelineDocument, EditError> {
  const trackResult = findTrackOrFail(document, trackId);
  if (!trackResult.ok) return trackResult;
  const unlocked = assertUnlocked(trackResult.value);
  if (!unlocked.ok) return unlocked;
  if (isEmpty(range)) return ok(document);

  const track = trackResult.value;
  const gap = range.duration;
  const rangeEnd = endExclusive(range);
  const survivors: Clip[] = [];

  for (const clip of trackClips(track)) {
    if (!overlaps(clip.span, range)) {
      survivors.push(
        clip.span.start >= rangeEnd
          ? ({
              ...clip,
              span: spanFromBounds(
                frameIndex(clip.span.start - gap),
                frameIndex(endExclusive(clip.span) - gap),
              ),
            } as Clip)
          : clip,
      );
      continue;
    }

    // `subtractSpan` yields the pieces of the clip the range did not cover, in timeline order.
    const pieces = subtractSpan(clip.span, range);
    pieces.forEach((piece, index) => {
      const offsetIntoClip = piece.start - clip.span.start;
      const shiftedStart = piece.start >= rangeEnd ? frameIndex(piece.start - gap) : piece.start;
      const base = shiftClipKeyframes(clip, -offsetIntoClip);
      survivors.push({
        ...base,
        // The first surviving piece keeps the original id so selection and effect bindings survive;
        // a second piece is genuinely new material and needs its own identity.
        id: index === 0 ? clip.id : idFactory(),
        span: spanFromBounds(shiftedStart, frameIndex(shiftedStart + piece.duration)),
        ...(clip.kind === 'text'
          ? {}
          : { source: advanceSource(clip.source, offsetIntoClip, document.frameRate) }),
      } as Clip);
    });
  }

  return ok(replaceTrack(document, withClips(track, survivors)));
}

/** Toggles a clip's contribution to the composite without removing it. */
export function setClipEnabled(
  document: TimelineDocument,
  clipId: ClipId,
  enabled: boolean,
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;
  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;
  if (located.value.clip.enabled === enabled) return ok(document);

  return ok(replaceTrack(document, replaceClip(located.value.track, { ...located.value.clip, enabled })));
}

/** Renames a clip. */
export function setClipLabel(
  document: TimelineDocument,
  clipId: ClipId,
  label: string,
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, clipId);
  if (!located.ok) return located;
  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;
  if (located.value.clip.label === label) return ok(document);

  return ok(replaceTrack(document, replaceClip(located.value.track, { ...located.value.clip, label })));
}
