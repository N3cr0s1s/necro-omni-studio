import type { ClipId, TrackId } from '@nos/core';

/**
 * Why an edit could not be applied.
 *
 * Every operation returns a `Result` rather than throwing or silently no-oping. A rejected edit is a
 * normal outcome — dragging a clip onto a locked track, trimming past the end of the source — and
 * the UI has to say *why*, in the same spirit as the spec's rule that an unavailable generator names
 * its reason instead of disappearing.
 */
export type EditError =
  | { readonly kind: 'track-not-found'; readonly track: TrackId }
  | { readonly kind: 'clip-not-found'; readonly clip: ClipId }
  | { readonly kind: 'track-locked'; readonly track: TrackId }
  | {
      readonly kind: 'wrong-track-kind';
      readonly track: TrackId;
      readonly accepts: readonly string[];
      readonly received: string;
    }
  | {
      readonly kind: 'collision';
      readonly track: TrackId;
      readonly withClip: ClipId;
    }
  /** The edit would leave a clip with no frames. Callers should delete instead. */
  | { readonly kind: 'empty-result'; readonly clip: ClipId }
  /** A trim asked for frames the source does not have. */
  | {
      readonly kind: 'source-exhausted';
      readonly clip: ClipId;
      readonly available: number;
      readonly requested: number;
    }
  /** A cut fell on a clip boundary, where it would produce a zero-length clip. */
  | { readonly kind: 'nothing-to-cut'; readonly track: TrackId }
  | { readonly kind: 'no-free-track'; readonly kindWanted: string }
  /** A track id already in use. Adding one anyway would replace a track and everything on it. */
  | { readonly kind: 'duplicate-track'; readonly track: TrackId }
  /** A name that is blank, which nothing could be referred to by. */
  | { readonly kind: 'empty-name'; readonly track?: TrackId; readonly clip?: ClipId };

export function describeEditError(error: EditError): string {
  switch (error.kind) {
    case 'track-not-found':
      return `Track ${error.track} no longer exists`;
    case 'clip-not-found':
      return `Clip ${error.clip} no longer exists`;
    case 'track-locked':
      return `Track ${error.track} is locked`;
    case 'wrong-track-kind':
      return `That track holds ${error.accepts.join(' or ')} clips, not ${error.received}`;
    case 'collision':
      return `That position overlaps clip ${error.withClip}`;
    case 'empty-result':
      return `That edit would leave clip ${error.clip} with no frames`;
    case 'source-exhausted':
      return `The source has ${error.available} frames available, ${error.requested} requested`;
    case 'nothing-to-cut':
      return 'There is nothing to cut at that position';
    case 'no-free-track':
      return `No free ${error.kindWanted} track is available`;
    case 'duplicate-track':
      return `Track ${error.track} already exists`;
    case 'empty-name':
      return 'A name cannot be blank';
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled edit error ${JSON.stringify(unreachable)}`);
    }
  }
}
