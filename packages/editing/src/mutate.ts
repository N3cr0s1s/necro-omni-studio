import {
  type Clip,
  type ClipId,
  type Result,
  type TimelineDocument,
  type Track,
  type TrackId,
  err,
  ok,
  trackClips,
} from '@nos/core';
import type { EditError } from './errors.js';

/**
 * Immutable update helpers.
 *
 * Every operation rebuilds only the path from the document root to the thing it changed, leaving
 * every other subtree by reference. That is what makes the snapshot-based undo history cheap: two
 * adjacent snapshots share all their untouched tracks and clips, so a history entry costs a handful
 * of pointers rather than a document copy.
 *
 * The helpers also return the *same* object when nothing changed, which the document store relies on
 * to skip recording a no-op edit.
 */

/** Replaces a track, preserving order. */
export function replaceTrack(document: TimelineDocument, next: Track): TimelineDocument {
  const tracks = document.sequence.tracks;
  const index = tracks.findIndex((track) => track.id === next.id);
  if (index < 0) return document;
  if (tracks[index] === next) return document;

  const updated = [...tracks];
  updated[index] = next;
  return { ...document, sequence: { ...document.sequence, tracks: updated } };
}

/**
 * Applies a function to a track's clips, keeping the track's kind.
 *
 * The cast is contained here rather than repeated at every call site. It is sound because callers
 * only ever produce clips a track already accepts — enforced by `assertAccepts` before any mutation
 * reaches this point.
 */
export function withClips(track: Track, next: readonly Clip[]): Track {
  if (next === trackClips(track)) return track;
  return { ...track, clips: next } as Track;
}

export function findTrackOrFail(document: TimelineDocument, id: TrackId): Result<Track, EditError> {
  const track = document.sequence.tracks.find((candidate) => candidate.id === id);
  return track === undefined ? err({ kind: 'track-not-found', track: id }) : ok(track);
}

export function locateClipOrFail(
  document: TimelineDocument,
  id: ClipId,
): Result<{ readonly track: Track; readonly clip: Clip }, EditError> {
  for (const track of document.sequence.tracks) {
    const clip = trackClips(track).find((candidate) => candidate.id === id);
    if (clip !== undefined) return ok({ track, clip });
  }
  return err({ kind: 'clip-not-found', clip: id });
}

/**
 * Rejects an edit on a locked track.
 *
 * Checked before every mutation rather than at the UI layer, because edits also arrive from the
 * generator framework importing output — and a finished, locked layer must not be disturbed by a job
 * completing in the background.
 */
export function assertUnlocked(track: Track): Result<Track, EditError> {
  return track.locked ? err({ kind: 'track-locked', track: track.id }) : ok(track);
}

/** Replaces one clip in a track by id. */
export function replaceClip(track: Track, next: Clip): Track {
  const clips = trackClips(track);
  const index = clips.findIndex((clip) => clip.id === next.id);
  if (index < 0) return track;
  if (clips[index] === next) return track;

  const updated = [...clips];
  updated[index] = next;
  return withClips(track, updated);
}

export function removeClipFromTrack(track: Track, id: ClipId): Track {
  const clips = trackClips(track);
  const remaining = clips.filter((clip) => clip.id !== id);
  return remaining.length === clips.length ? track : withClips(track, remaining);
}

export function addClipToTrack(track: Track, clip: Clip): Track {
  return withClips(track, [...trackClips(track), clip]);
}

/** Convenience: locate a clip, transform it, write it back. */
export function updateClip(
  document: TimelineDocument,
  id: ClipId,
  transform: (clip: Clip, track: Track) => Result<Clip, EditError>,
): Result<TimelineDocument, EditError> {
  const located = locateClipOrFail(document, id);
  if (!located.ok) return located;

  const unlocked = assertUnlocked(located.value.track);
  if (!unlocked.ok) return unlocked;

  const next = transform(located.value.clip, located.value.track);
  if (!next.ok) return next;
  if (next.value === located.value.clip) return ok(document);

  return ok(replaceTrack(document, replaceClip(located.value.track, next.value)));
}
