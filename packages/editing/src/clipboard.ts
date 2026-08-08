import {
  type Clip,
  type ClipId,
  type FrameIndex,
  type Result,
  type TimelineDocument,
  type Track,
  type TrackId,
  type TrackKind,
  err,
  frameIndex,
  isSpanFree,
  locateClip,
  ok,
  spanFromBounds,
  trackAccepts,
  trackClips,
} from '@nos/core';
import type { EditError } from './errors.js';
import { addClipToTrack, assertUnlocked, findTrackOrFail, replaceTrack } from './mutate.js';

/**
 * Copying and pasting clips.
 *
 * Not named in the spec, and not optional either: an editor without it makes a user rebuild a
 * three-clip lower-third by hand every time they want a second one. It is the one editing capability
 * this project had never modelled at all — everything else existed and merely needed reaching.
 *
 * The design turns on one question: **what does a copied clip remember?** Not its absolute position,
 * which is the one thing the user is about to change, but its offset from the earliest clip in the
 * copy. That is what makes a multi-clip paste preserve the *shape* of what was copied — a title and
 * its music cue land the same distance apart wherever they are put down.
 */

/**
 * A clip in the clipboard.
 *
 * Carries the whole clip, so effects, keyframes, provenance and links come with it. The offset
 * replaces the span's start; the duration stays, since a copy is the same length as its original.
 */
export interface ClipboardEntry {
  readonly clip: Clip;
  /** Frames from the start of the earliest clip in the copy. */
  readonly offset: number;
  /** Where it came from, so a paste can prefer the same track. */
  readonly track: TrackId;
  readonly trackKind: TrackKind;
}

export interface Clipboard {
  readonly entries: readonly ClipboardEntry[];
  /** Total span the copy covers, for a caller that wants to say what will be pasted. */
  readonly durationFrames: number;
}

export const EMPTY_CLIPBOARD: Clipboard = { entries: [], durationFrames: 0 };

/**
 * Snapshots clips into a clipboard.
 *
 * A value rather than a reference into the document: the clips it holds must survive the originals
 * being deleted, which is exactly what a cut is.
 */
export function copyClips(document: TimelineDocument, ids: readonly ClipId[]): Clipboard {
  const located = ids
    .map((id) => locateClip(document, id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  if (located.length === 0) return EMPTY_CLIPBOARD;

  const origin = Math.min(...located.map((entry) => entry.clip.span.start));
  const end = Math.max(...located.map((entry) => entry.clip.span.start + entry.clip.span.duration));

  return {
    entries: located.map((entry) => ({
      clip: entry.clip,
      offset: entry.clip.span.start - origin,
      track: entry.track.id,
      trackKind: entry.track.kind,
    })),
    durationFrames: end - origin,
  };
}

export interface PasteRequest {
  /** Where the earliest clip in the copy lands. */
  readonly at: FrameIndex;
  /**
   * Ids for the pasted clips, in clipboard order.
   *
   * Supplied rather than generated, like every other operation in this package: the same sequence of
   * actions must produce the same document, or an undo comparison and a saved-file diff both stop
   * meaning anything.
   */
  readonly ids: readonly ClipId[];
}

export interface PasteResult {
  readonly document: TimelineDocument;
  readonly clips: readonly ClipId[];
}

/**
 * Pastes a clipboard at a frame.
 *
 * **All or nothing.** If any clip would land on top of something, the whole paste is refused rather
 * than dropping the ones that fit: a half-pasted lower third is not a thing anyone wanted, and the
 * user cannot see which half is missing without comparing against a clipboard they cannot inspect.
 *
 * Each clip prefers the track it came from, and falls back to the first track of its kind — a copy
 * made before a track was removed is still worth pasting, just not onto a track that is gone.
 */
export function pasteClips(
  document: TimelineDocument,
  clipboard: Clipboard,
  request: PasteRequest,
): Result<PasteResult, EditError> {
  if (clipboard.entries.length === 0) return ok({ document, clips: [] });
  if (request.ids.length < clipboard.entries.length) {
    return err({ kind: 'empty-result', clip: clipboard.entries[0]!.clip.id });
  }

  const placements: { track: Track; clip: Clip }[] = [];

  for (const [index, entry] of clipboard.entries.entries()) {
    const destination = destinationFor(document, entry);
    if (!destination.ok) return destination;

    const unlocked = assertUnlocked(destination.value);
    if (!unlocked.ok) return unlocked;

    const start = frameIndex(Math.max(0, request.at + entry.offset));
    const span = spanFromBounds(frameIndex(start), frameIndex(start + entry.clip.span.duration));
    const clip = { ...entry.clip, id: request.ids[index]!, span } as Clip;

    if (!trackAccepts(destination.value, clip)) {
      return err({
        kind: 'wrong-track-kind',
        track: destination.value.id,
        accepts: [destination.value.kind],
        received: clip.kind,
      });
    }

    // Checked against the placements already made as well as the document, or two clips of one paste
    // could be reported as fitting and then land on each other.
    const occupied = placements
      .filter((placed) => placed.track.id === destination.value.id)
      .map((placed) => placed.clip);
    const blocker = collision(destination.value, occupied, clip);
    if (blocker !== undefined) {
      return err({ kind: 'collision', track: destination.value.id, withClip: blocker });
    }

    placements.push({ track: destination.value, clip });
  }

  // Applied only once every placement is known to be legal, which is what makes the refusal atomic.
  let next = document;
  for (const placement of placements) {
    const track = next.sequence.tracks.find((candidate) => candidate.id === placement.track.id);
    if (track === undefined) continue;
    next = replaceTrack(next, addClipToTrack(track, placement.clip));
  }

  return ok({ document: next, clips: placements.map((placement) => placement.clip.id) });
}

/**
 * A frame where a clipboard fits on its own tracks, at or after a starting point.
 *
 * Offered so a caller can turn a refusal into the result the user wanted — "paste after what is
 * already there" — rather than making them find the gap by eye. Searches forward only: pasting
 * *earlier* than asked would be a surprise, where later is the ordinary reading of "put it down".
 */
export function firstFreePaste(
  document: TimelineDocument,
  clipboard: Clipboard,
  from: FrameIndex,
): FrameIndex {
  if (clipboard.entries.length === 0) return from;

  let candidate = Math.max(0, from);
  // Bounded by the material: past the end of every track nothing can collide, so the loop always
  // terminates well before this.
  const limit = candidate + trackSpan(document) + clipboard.durationFrames + 1;

  while (candidate <= limit) {
    let blocked = 0;
    for (const entry of clipboard.entries) {
      const destination = destinationFor(document, entry);
      if (!destination.ok) continue;

      const start = candidate + entry.offset;
      const span = spanFromBounds(frameIndex(start), frameIndex(start + entry.clip.span.duration));
      if (!isSpanFree(destination.value, span)) {
        // Jump to just past whatever is in the way rather than stepping a frame at a time.
        const obstacle = trackClips(destination.value)
          .filter((clip) => clip.span.start + clip.span.duration > start)
          .reduce(
            (soonest, clip) => Math.min(soonest, clip.span.start + clip.span.duration),
            Number.POSITIVE_INFINITY,
          );
        blocked = Math.max(blocked, obstacle - entry.offset);
      }
    }

    if (blocked === 0) return frameIndex(candidate);
    candidate = Math.max(candidate + 1, blocked);
  }

  return frameIndex(candidate);
}

function destinationFor(document: TimelineDocument, entry: ClipboardEntry): Result<Track, EditError> {
  const original = document.sequence.tracks.find((track) => track.id === entry.track);
  if (original !== undefined) return ok(original);

  // The track it came from is gone. The first of its kind is the honest fallback: the clip is still
  // meaningful, and refusing would make a copy expire the moment a track was tidied away.
  const sameKind = document.sequence.tracks.find((track) => track.kind === entry.trackKind);
  return sameKind === undefined ? findTrackOrFail(document, entry.track) : ok(sameKind);
}

function collision(track: Track, pending: readonly Clip[], clip: Clip): ClipId | undefined {
  const existing = trackClips(track).find(
    (candidate) => candidate.id !== clip.id && overlapsSpan(candidate, clip),
  );
  if (existing !== undefined) return existing.id;
  return pending.find((candidate) => overlapsSpan(candidate, clip))?.id;
}

function overlapsSpan(left: Clip, right: Clip): boolean {
  return (
    left.span.start < right.span.start + right.span.duration &&
    right.span.start < left.span.start + left.span.duration
  );
}

function trackSpan(document: TimelineDocument): number {
  let end = 0;
  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      end = Math.max(end, clip.span.start + clip.span.duration);
    }
  }
  return end;
}
