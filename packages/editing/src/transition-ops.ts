import {
  type Clip,
  type ClipId,
  type EffectId,
  type EffectInstanceId,
  type ImageClip,
  type Result,
  type TimelineDocument,
  type Transition,
  type VideoClip,
  type VideoTrack,
  endExclusive,
  err,
  frameIndex,
  intersection,
  ok,
  spanFromBounds,
} from '@nos/core';
import type { EditError } from './errors.js';
import { type EditOptions, UNBOUNDED_SOURCES } from './clip-ops.js';
import { replaceTrack } from './mutate.js';

/**
 * Transitions.
 *
 * The spec's model, and the reason a transition is its own entity rather than an effect on either clip:
 * it **samples both** and its `progress` is computed by the engine from the overlap. Exposing progress
 * as a keyframable parameter is explicitly forbidden, because the engine would overwrite whatever the
 * user authored.
 *
 * A transition therefore needs a real overlap — the plan only builds one when both clips are live at the
 * frame. Two clips butted at a cut have none, so creating a transition **consumes handles**: the
 * outgoing clip extends past the cut and the incoming clip starts before it, each by half the duration.
 * That is the conventional centred transition, and it is why `SourceBounds` matters here — a clip with
 * no material beyond its out-point cannot be extended, and the honest response is a rejection with a
 * reason rather than a transition that shows a frozen frame.
 */

export type TransitionError =
  | EditError
  | { readonly kind: 'not-adjacent'; readonly from: ClipId; readonly to: ClipId }
  | { readonly kind: 'no-handles'; readonly clip: ClipId; readonly needed: number }
  | { readonly kind: 'too-long'; readonly maximum: number }
  | { readonly kind: 'not-a-video-track'; readonly track: string };

export interface AddTransitionRequest {
  readonly from: ClipId;
  readonly to: ClipId;
  readonly effect: EffectId;
  /** Total overlap, split evenly across the cut. */
  readonly durationFrames: number;
  readonly id: EffectInstanceId;
  readonly params?: Transition['params'];
}

/** The shortest transition worth having. One frame is a cut with extra machinery. */
export const MIN_TRANSITION_FRAMES = 2;

/**
 * Adds a transition across the cut between two adjacent clips.
 *
 * Both clips keep their content: the overlap is made from material that already exists beyond each
 * clip's edge, so nothing the user cut is discarded and the sequence does not change length.
 */
export function addTransition(
  document: TimelineDocument,
  request: AddTransitionRequest,
  options: EditOptions = {},
): Result<TimelineDocument, TransitionError> {
  // Changing an existing transition's effect or length is the same gesture as creating one, so the
  // operation starts by undoing whatever already joins this pair. Without that the clips are already
  // overlapping on the second call and the adjacency check rejects it — leaving a user who wanted a
  // different dissolve with no way to ask for one.
  const existing = findJoining(document, request.from, request.to);
  const base = existing === undefined ? document : restore(document, existing);

  const found = locatePair(base, request.from, request.to);
  if (!found.ok) return found;

  const { track, from, to } = found.value;
  void document;
  if (track.locked) return err({ kind: 'track-locked', track: track.id });

  /*
   * Clips that **already** overlap keep the overlap they have.
   *
   * Dropping one clip onto another is how a dissolve is made now, and it leaves the pair overlapping
   * rather than meeting at a cut — so this refused, and there was no way to turn a dissolve made that
   * way into a wipe. The user had to undo the drop and start again through this dialog, which is the
   * dead end the drop gesture was added to remove.
   *
   * The existing overlap becomes the transition's span, and neither edge moves: the geometry is the
   * user's, already placed, and a request for a *different* length is a request to move a clip, which
   * is not what naming an effect means. The requested duration therefore governs only the handle-
   * consuming case below, where there is no overlap yet to respect.
   */
  const already = intersection(from.span, to.span);
  if (already !== undefined && already.duration >= MIN_TRANSITION_FRAMES) {
    const transition: Transition = {
      id: request.id,
      effect: request.effect,
      span: already,
      from: request.from,
      to: request.to,
      params: request.params ?? {},
    };
    return ok(
      replaceTrack(base, {
        ...track,
        transitions: [...track.transitions.filter((entry) => !overlapsSpan(entry, already)), transition],
      }),
    );
  }

  if (endExclusive(from.span) !== to.span.start) {
    return err({ kind: 'not-adjacent', from: request.from, to: request.to });
  }

  const duration = Math.round(request.durationFrames);
  if (duration < MIN_TRANSITION_FRAMES) return err({ kind: 'too-long', maximum: MIN_TRANSITION_FRAMES });

  // Neither clip may be wholly consumed: a transition longer than the material it joins is a dissolve
  // between two things the viewer never sees.
  const maximum = Math.min(from.span.duration, to.span.duration) * 2 - 1;
  if (duration > maximum) return err({ kind: 'too-long', maximum });

  const before = Math.floor(duration / 2);
  const after = duration - before;

  const sources = options.sources ?? UNBOUNDED_SOURCES;
  // The outgoing clip grows forward past the cut; the incoming one starts earlier. Each needs material
  // on that side, and a source with none cannot supply it.
  const outgoing = extendEnd(from, after, sources);
  if (!outgoing.ok) return outgoing;
  const incoming = extendStart(to, before, sources);
  if (!incoming.ok) return incoming;

  const span = spanFromBounds(frameIndex(to.span.start - before), frameIndex(to.span.start + after));
  const transition: Transition = {
    id: request.id,
    effect: request.effect,
    span,
    from: request.from,
    to: request.to,
    params: request.params ?? {},
  };

  const clips = track.clips.map((clip) => {
    if (clip.id === from.id) return outgoing.value;
    if (clip.id === to.id) return incoming.value;
    return clip;
  });

  return ok(
    replaceTrack(base, {
      ...track,
      clips,
      // Replaced rather than appended when one already covers this cut: two transitions on one overlap
      // would leave the plan picking whichever it found first.
      transitions: [...track.transitions.filter((entry) => !overlapsSpan(entry, span)), transition],
    }),
  );
}

/**
 * Changes a transition's parameters.
 *
 * The gap this closes: a transition could be added and removed and nothing else. `Transition.params`
 * was in the document, the compositor read it, and the built-in wipe declares a `softness` — so every
 * wipe in every project was stuck at the manifest's default with no way to ask for a different one.
 *
 * Separate from `addTransition`, which rebuilds the overlap and moves both clips' edges. Changing a
 * number a shader reads must not touch the cut, and routing it through the same call would make an
 * undo of "softness" restore two clip spans as well.
 */
export function setTransitionParams(
  document: TimelineDocument,
  id: EffectInstanceId,
  params: Transition['params'],
): Result<TimelineDocument, TransitionError> {
  for (const track of document.sequence.tracks) {
    if (track.kind !== 'video') continue;
    const existing = track.transitions.find((entry) => entry.id === id);
    if (existing === undefined) continue;
    if (track.locked) return err({ kind: 'track-locked', track: track.id });

    return ok(
      replaceTrack(document, {
        ...track,
        transitions: track.transitions.map((entry) => (entry.id === id ? { ...entry, params } : entry)),
      }),
    );
  }

  return err({ kind: 'clip-not-found', clip: id as unknown as ClipId });
}

/** Removes a transition, returning both clips to their original edges. */
export function removeTransition(
  document: TimelineDocument,
  id: EffectInstanceId,
): Result<TimelineDocument, TransitionError> {
  for (const track of document.sequence.tracks) {
    if (track.kind !== 'video') continue;
    const transition = track.transitions.find((entry) => entry.id === id);
    if (transition === undefined) continue;
    if (track.locked) return err({ kind: 'track-locked', track: track.id });
    return ok(restore(document, transition));
  }

  return err({ kind: 'clip-not-found', clip: id as unknown as ClipId });
}

/** The transition joining exactly this pair, if there is one. */
function findJoining(document: TimelineDocument, fromId: ClipId, toId: ClipId): Transition | undefined {
  for (const track of document.sequence.tracks) {
    if (track.kind !== 'video') continue;
    const found = track.transitions.find((entry) => entry.from === fromId && entry.to === toId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Undoes a transition: both clips return to the cut and the record is dropped.
 *
 * The cut is the middle of the overlap, because that is how it was created — half the duration taken
 * from each side. Reconstructing it from the span alone means nothing has to remember how the
 * transition was made.
 */
function restore(document: TimelineDocument, transition: Transition): TimelineDocument {
  for (const track of document.sequence.tracks) {
    if (track.kind !== 'video') continue;
    if (!track.transitions.some((entry) => entry.id === transition.id)) continue;

    const transitions = track.transitions.filter((entry) => entry.id !== transition.id);
    const from = track.clips.find((clip) => clip.id === transition.from);
    const to = track.clips.find((clip) => clip.id === transition.to);

    // The clips are gone; drop the record rather than leaving a transition referencing nothing.
    if (from === undefined || to === undefined) return replaceTrack(document, { ...track, transitions });

    const cut = frameIndex(transition.span.start + Math.floor(transition.span.duration / 2));
    const restoredFrom = withEnd(from, cut);
    const restoredTo = withStart(to, cut);

    return replaceTrack(document, {
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.id === from.id) return restoredFrom;
        if (clip.id === to.id) return restoredTo;
        return clip;
      }),
      transitions,
    });
  }
  return document;
}

/** Transitions on a track, for the inspector. */
export function transitionsOf(document: TimelineDocument, clipId: ClipId): readonly Transition[] {
  for (const track of document.sequence.tracks) {
    if (track.kind !== 'video') continue;
    const matching = track.transitions.filter((entry) => entry.from === clipId || entry.to === clipId);
    if (matching.length > 0) return matching;
  }
  return [];
}

/** A one-line reason, for the UI. */
export function describeTransitionError(error: TransitionError): string {
  switch (error.kind) {
    case 'not-adjacent':
      return 'a transition needs two clips that meet at a cut';
    case 'no-handles':
      return `there is not enough material beyond the cut — ${error.needed} more frames are needed`;
    case 'too-long':
      return `the longest transition these clips can carry is ${error.maximum} frames`;
    case 'not-a-video-track':
      return 'transitions apply to video tracks';
    case 'track-locked':
      return 'the track is locked';
    default:
      return `the transition was rejected: ${String(error.kind).replace(/-/g, ' ')}`;
  }
}

type VideoLike = VideoClip | ImageClip;

function locatePair(
  document: TimelineDocument,
  fromId: ClipId,
  toId: ClipId,
): Result<{ track: VideoTrack; from: VideoLike; to: VideoLike }, TransitionError> {
  for (const track of document.sequence.tracks) {
    if (track.kind !== 'video') continue;
    const from = track.clips.find((clip) => clip.id === fromId);
    const to = track.clips.find((clip) => clip.id === toId);
    if (from === undefined || to === undefined) continue;
    return ok({ track, from, to });
  }
  return err({ kind: 'clip-not-found', clip: fromId });
}

/**
 * Extends a clip's out-point, if its source has material there.
 *
 * An image has no source length, so it can always be extended: a still frame held longer is exactly
 * what the user sees either way.
 */
function extendEnd(
  clip: VideoLike,
  frames: number,
  sources: NonNullable<EditOptions['sources']>,
): Result<VideoLike, TransitionError> {
  if (frames === 0) return ok(clip);

  const bounds = clip.kind === 'image' ? undefined : sources.boundsFor(clip as Clip);
  if (bounds !== undefined) {
    const used = clip.source.sourceIn + clip.span.duration;
    const available = bounds.totalFrames - used;
    if (available < frames) {
      return err({ kind: 'no-handles', clip: clip.id, needed: frames - Math.max(0, available) });
    }
  }

  return ok({
    ...clip,
    span: spanFromBounds(clip.span.start, frameIndex(endExclusive(clip.span) + frames)),
  } as VideoLike);
}

/** Moves a clip's in-point earlier, consuming the handle before it. */
function extendStart(
  clip: VideoLike,
  frames: number,
  sources: NonNullable<EditOptions['sources']>,
): Result<VideoLike, TransitionError> {
  if (frames === 0) return ok(clip);

  const sourceIn = clip.kind === 'image' ? Number.POSITIVE_INFINITY : clip.source.sourceIn;
  if (clip.kind !== 'image' && sourceIn < frames) {
    return err({ kind: 'no-handles', clip: clip.id, needed: frames - sourceIn });
  }
  void sources;

  const start = frameIndex(Math.max(0, clip.span.start - frames));
  return ok({
    ...clip,
    span: spanFromBounds(start, endExclusive(clip.span)),
    ...(clip.kind === 'image'
      ? {}
      : { source: { ...clip.source, sourceIn: frameIndex(clip.source.sourceIn - frames) } }),
  } as VideoLike);
}

/** Puts a clip's out-point back where it was, discarding the handle the transition borrowed. */
function withEnd(clip: VideoLike, end: ReturnType<typeof frameIndex>): VideoLike {
  if (end <= clip.span.start || end === endExclusive(clip.span)) return clip;
  return { ...clip, span: spanFromBounds(clip.span.start, end) } as VideoLike;
}

/** Puts a clip's in-point back, returning the source offset it borrowed with it. */
function withStart(clip: VideoLike, start: ReturnType<typeof frameIndex>): VideoLike {
  if (start >= endExclusive(clip.span) || start === clip.span.start) return clip;
  const shift = start - clip.span.start;
  return {
    ...clip,
    span: spanFromBounds(start, endExclusive(clip.span)),
    ...(clip.kind === 'image'
      ? {}
      : { source: { ...clip.source, sourceIn: frameIndex(clip.source.sourceIn + shift) } }),
  } as VideoLike;
}

function overlapsSpan(transition: Transition, span: Transition['span']): boolean {
  return transition.span.start < endExclusive(span) && span.start < endExclusive(transition.span);
}
