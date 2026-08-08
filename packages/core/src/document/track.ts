import { type FrameCount, type FrameIndex, frameCount, frameIndex } from '../time/frame-time.js';
import { type FrameSpan, compareSpans, endExclusive, overlaps } from '../time/frame-span.js';
import {
  type AudioClip,
  type Clip,
  type ImageClip,
  type TextClip,
  type Transition,
  type VideoClip,
} from './clip.js';
import { type ClipId, type TrackId } from './ids.js';

/**
 * Track types, as fixed by the spec: N video, N audio, N text.
 *
 * A track's kind constrains which clip kinds it may hold, which is what makes the
 * mockups' visual distinction between track types meaningful rather than decorative.
 */
export type TrackKind = 'video' | 'audio' | 'text';

export interface TrackBase {
  readonly id: TrackId;
  readonly kind: TrackKind;
  /** Display name: `V1`, `A2 · music`, `T1 · text`. */
  readonly name: string;
  /** Excluded from the composite and the mix. */
  readonly muted: boolean;
  /** When any track is soloed, only soloed tracks contribute. */
  readonly solo: boolean;
  /** Rejects edits, so a finished layer cannot be disturbed by a stray drag. */
  readonly locked: boolean;
  /** Row height in pixels. Persisted so a layout survives a reload. */
  readonly height: number;
  /** Collapsed tracks hide their keyframe lanes. */
  readonly collapsed: boolean;
}

export interface VideoTrack extends TrackBase {
  readonly kind: 'video';
  readonly clips: readonly (VideoClip | ImageClip)[];
  readonly transitions: readonly Transition[];
}

export interface AudioTrack extends TrackBase {
  readonly kind: 'audio';
  readonly clips: readonly AudioClip[];
  /** Linear track gain applied after clip gain. */
  readonly gain: number;
  /** −1 to +1. */
  readonly pan: number;
}

export interface TextTrack extends TrackBase {
  readonly kind: 'text';
  readonly clips: readonly TextClip[];
}

export type Track = VideoTrack | AudioTrack | TextTrack;

/**
 * A rectangle of timeline, as the document understands one.
 *
 * Frames and track ids rather than pixels: a marquee is drawn in pixels, but *which clips it touches*
 * is a question about the document. Living here rather than in the editing package lets the timeline
 * component report one without depending on the operations that consume it.
 */
export interface SelectionRegion {
  readonly span: FrameSpan;
  /** Tracks the rectangle crosses, in document order. */
  readonly tracks: readonly TrackId[];
}

/** Clip kinds each track kind accepts. Enforced by the editing operations. */
export const TRACK_ACCEPTS: Readonly<Record<TrackKind, readonly Clip['kind'][]>> = {
  video: ['video', 'image'],
  audio: ['audio'],
  text: ['text'],
};

export function trackAccepts(track: Track, clip: Clip): boolean {
  return TRACK_ACCEPTS[track.kind].includes(clip.kind);
}

/** Widened accessor, so callers that do not care about track kind stay simple. */
export function trackClips(track: Track): readonly Clip[] {
  return track.clips;
}

export function findClip(track: Track, id: ClipId): Clip | undefined {
  return trackClips(track).find((clip) => clip.id === id);
}

/**
 * Clips in timeline order.
 *
 * The document stores clips in a plain array; nothing guarantees insertion happened in
 * order, and every hit test, ripple and neighbour lookup needs them sorted. Sorting here
 * rather than maintaining an invariant on write keeps patches trivially composable.
 */
export function sortedClips(track: Track): readonly Clip[] {
  return [...trackClips(track)].sort((a, b) => compareSpans(a.span, b.span));
}

/** The clip covering a frame, or `undefined` in a gap. */
export function clipAt(track: Track, frame: FrameIndex): Clip | undefined {
  return trackClips(track).find((clip) => frame >= clip.span.start && frame < endExclusive(clip.span));
}

/**
 * Clips overlapping a span, in timeline order.
 *
 * Used for collision checks before an insert and for gathering what a ripple must move.
 */
export function clipsIn(track: Track, span: FrameSpan): readonly Clip[] {
  return sortedClips(track).filter((clip) => overlaps(clip.span, span));
}

/**
 * Whether a span is free, optionally ignoring one clip.
 *
 * The exclusion matters for a move: a clip must not collide with its own current
 * placement while being dragged.
 */
export function isSpanFree(track: Track, span: FrameSpan, ignore?: ClipId): boolean {
  return !trackClips(track).some((clip) => clip.id !== ignore && overlaps(clip.span, span));
}

/** Last frame occupied by any clip on the track. Zero for an empty track. */
export function trackEnd(track: Track): FrameIndex {
  let end = 0;
  for (const clip of trackClips(track)) {
    const clipEnd = endExclusive(clip.span);
    if (clipEnd > end) end = clipEnd;
  }
  return frameIndex(end);
}

export function trackDuration(track: Track): FrameCount {
  return frameCount(trackEnd(track));
}

/** Nearest clip starting at or after a frame — the target of a "free slot" search. */
export function nextClipFrom(track: Track, frame: FrameIndex): Clip | undefined {
  return sortedClips(track).find((clip) => clip.span.start >= frame);
}

export function previousClipBefore(track: Track, frame: FrameIndex): Clip | undefined {
  const before = sortedClips(track).filter((clip) => endExclusive(clip.span) <= frame);
  return before[before.length - 1];
}

/**
 * Every frame position an edit could snap to on this track.
 *
 * Clip edges only — the playhead and markers are sequence-level and are added by the
 * caller, because a track does not know about them.
 */
export function snapPoints(track: Track): readonly FrameIndex[] {
  const points: FrameIndex[] = [];
  for (const clip of trackClips(track)) {
    points.push(clip.span.start, endExclusive(clip.span));
  }
  return points;
}

/**
 * Whether a track contributes to output, given whether anything is soloed.
 *
 * Solo has to be evaluated against the whole track set, not per track, so this takes the
 * global flag rather than reading it from a parent the track does not have.
 */
export function isTrackAudible(track: Track, anySoloed: boolean): boolean {
  if (track.muted) return false;
  return anySoloed ? track.solo : true;
}
