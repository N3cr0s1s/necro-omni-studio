import {
  type Result,
  type TimelineDocument,
  type Track,
  type TrackId,
  type TrackKind,
  DEFAULT_TRACK_HEIGHTS,
  err,
  ok,
  trackClips,
  trackId,
} from '@nos/core';
import type { EditError } from './errors.js';

/**
 * Adding and removing tracks.
 *
 * The spec's timeline is **N video, N audio, N text**, and the mockups' `+ Track` button is how a user
 * reaches the second of anything. Until now a project had exactly one track of each kind for its whole
 * life, so a title over a title, or music under dialogue, was simply not expressible.
 *
 * Ids come from the caller rather than a counter here, for the same reason every other operation in
 * this package takes them: the same sequence of actions must produce the same document, which is what
 * makes an undo comparison meaningful and a saved file diffable.
 */

/** The prefix a user sees on a track of each kind, matching the mockups. */
const TRACK_PREFIX: Readonly<Record<TrackKind, string>> = { video: 'V', audio: 'A', text: 'T' };

export interface AddTrackRequest {
  readonly kind: TrackKind;
  /** Supplied by the caller so the operation stays pure. */
  readonly id: TrackId;
  /** Overrides the derived `V2`-style name. */
  readonly name?: string;
}

export interface AddTrackResult {
  readonly document: TimelineDocument;
  readonly track: Track;
}

/**
 * Adds an empty track.
 *
 * Placed **after the last track of its own kind**, not at the end of the list. The timeline reads
 * top-to-bottom as video, then audio, then text; a new video track appearing below the audio would
 * break that reading for every project it happened in, and no amount of naming would recover it.
 */
export function addTrack(
  document: TimelineDocument,
  request: AddTrackRequest,
): Result<AddTrackResult, EditError> {
  if (document.sequence.tracks.some((track) => track.id === request.id)) {
    // A duplicate id would silently replace an existing track and everything on it.
    return err({ kind: 'duplicate-track', track: request.id });
  }

  const track = createTrack(request.kind, {
    id: request.id,
    name: request.name ?? nextTrackName(document, request.kind),
  });

  const tracks = [...document.sequence.tracks];
  const lastOfKind = lastIndexOfKind(tracks, request.kind);
  tracks.splice(lastOfKind + 1, 0, track);

  return ok({ document: { ...document, sequence: { ...document.sequence, tracks } }, track });
}

/**
 * Removes a track and everything on it.
 *
 * Its clips go with it rather than the removal being refused. Every editor works this way and undo is
 * the safety net that makes it reasonable — requiring a track to be emptied first would mean deleting
 * fifty clips by hand to get rid of one row.
 *
 * A **locked** track is refused, which is the one case where that reasoning does not hold: locking
 * exists precisely to say "do not disturb this", and honouring it for stray drags but not for removal
 * would make the lock worth nothing.
 */
export function removeTrack(document: TimelineDocument, id: TrackId): Result<TimelineDocument, EditError> {
  const track = document.sequence.tracks.find((candidate) => candidate.id === id);
  if (track === undefined) return err({ kind: 'track-not-found', track: id });
  if (track.locked) return err({ kind: 'track-locked', track: id });

  const tracks = document.sequence.tracks.filter((candidate) => candidate.id !== id);
  return ok({ ...document, sequence: { ...document.sequence, tracks } });
}

/** The monitoring and protection flags a track header exposes. */
export type TrackFlag = 'muted' | 'solo' | 'locked' | 'collapsed';

/**
 * Toggles one of a track's flags.
 *
 * A **locked** track can still be muted, soloed and collapsed. Locking protects a track's *content*
 * from being disturbed — that is what it is for, and what every editing operation honours — where the
 * others change only what is being listened to or looked at. Refusing them would make locking a
 * finished layer mean giving up the ability to hear the rest of the mix without it, or to get it out
 * of the way while working on something else.
 */
export function toggleTrackFlag(
  document: TimelineDocument,
  id: TrackId,
  flag: TrackFlag,
): Result<TimelineDocument, EditError> {
  const index = document.sequence.tracks.findIndex((track) => track.id === id);
  const track = document.sequence.tracks[index];
  if (track === undefined) return err({ kind: 'track-not-found', track: id });

  const tracks = [...document.sequence.tracks];
  tracks[index] = { ...track, [flag]: !track[flag] } as Track;
  return ok({ ...document, sequence: { ...document.sequence, tracks } });
}

/**
 * Renames a track.
 *
 * A blank name is refused rather than accepted and rendered as an empty header: the name is how a
 * user says "put it on A2", and a row with nothing in it cannot be referred to at all. A **locked**
 * track can still be renamed — locking protects what is on a track, and the label is not on it.
 */
export function renameTrack(
  document: TimelineDocument,
  id: TrackId,
  name: string,
): Result<TimelineDocument, EditError> {
  const trimmed = name.trim();
  const index = document.sequence.tracks.findIndex((track) => track.id === id);
  const track = document.sequence.tracks[index];
  if (track === undefined) return err({ kind: 'track-not-found', track: id });
  if (trimmed === '') return err({ kind: 'empty-name', track: id });
  if (track.name === trimmed) return ok(document);

  const tracks = [...document.sequence.tracks];
  tracks[index] = { ...track, name: trimmed } as Track;
  return ok({ ...document, sequence: { ...document.sequence, tracks } });
}

/**
 * The range a track's height may take.
 *
 * The floor keeps a row tall enough to hold its own controls; the ceiling stops one track from
 * filling the window and hiding every other, which is the failure a free-form drag produces within
 * about two seconds of a user discovering it.
 */
export const TRACK_HEIGHT_RANGE = { min: 28, max: 220 } as const;

/**
 * Resizes a track.
 *
 * Persisted on the document because the spec says so — a layout that reset on every open would be
 * re-made every session. A **locked** track resizes like any other: locking protects what is on a
 * track, and its height is not on it.
 */
export function setTrackHeight(
  document: TimelineDocument,
  id: TrackId,
  height: number,
): Result<TimelineDocument, EditError> {
  const index = document.sequence.tracks.findIndex((track) => track.id === id);
  const track = document.sequence.tracks[index];
  if (track === undefined) return err({ kind: 'track-not-found', track: id });

  const clamped = Math.round(Math.min(TRACK_HEIGHT_RANGE.max, Math.max(TRACK_HEIGHT_RANGE.min, height)));
  if (track.height === clamped) return ok(document);

  const tracks = [...document.sequence.tracks];
  tracks[index] = { ...track, height: clamped } as Track;
  return ok({ ...document, sequence: { ...document.sequence, tracks } });
}

/** How many clips a removal would take with it, so the caller can say so before doing it. */
export function clipsOnTrack(document: TimelineDocument, id: TrackId): number {
  const track = document.sequence.tracks.find((candidate) => candidate.id === id);
  return track === undefined ? 0 : trackClips(track).length;
}

/**
 * The name the next track of a kind should carry.
 *
 * Counted from how many exist rather than from the highest number in use: after removing `V2` from
 * `V1, V2, V3`, the next track is `V3` again, which collides with a name already on screen. Counting
 * the *gap* instead would produce `V4` after a removal, leaving a hole a user reads as a bug. So the
 * first unused ordinal wins.
 */
export function nextTrackName(document: TimelineDocument, kind: TrackKind): string {
  const taken = new Set(document.sequence.tracks.filter((t) => t.kind === kind).map((t) => t.name));
  const prefix = TRACK_PREFIX[kind];
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = `${prefix}${ordinal}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A suggested id for a new track, for a caller with no id scheme of its own.
 *
 * Uniqueness is checked **case-insensitively**. A project whose first track is `V1` would otherwise
 * be handed `v1` for its second — two ids that differ only in case, indistinguishable in every log
 * line and error message the user will ever read, and one careless comparison away from being the
 * same track.
 *
 * The id it hands back is in the same case as `nextTrackName` uses, because the user reads both. A
 * generated track called `a2` sitting under `A1` looks like something the application did rather than
 * something they asked for — which is exactly what the naming rule exists to avoid.
 */
export function nextTrackId(document: TimelineDocument, kind: TrackKind): TrackId {
  const taken = new Set(document.sequence.tracks.map((track) => (track.id as string).toLowerCase()));
  const prefix = TRACK_PREFIX[kind];
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = `${prefix}${ordinal}`;
    if (!taken.has(candidate.toLowerCase())) return trackId(candidate);
  }
}

/**
 * The first track of a kind, which is where material of that kind lands by default.
 *
 * Resolved rather than assumed. Fixed ids were safe only while the track list could not change; now
 * that it can, an import targeting a hard-coded `v1` would fail on any project whose first video
 * track was removed and remade.
 */
export function firstTrackOfKind(document: TimelineDocument, kind: TrackKind): Track | undefined {
  return document.sequence.tracks.find((track) => track.kind === kind);
}

/**
 * Builds an empty track.
 *
 * Exported because generated material creates tracks too, and two constructors would drift the moment
 * either grew a field — a new audio track with a default gain the user did not choose is a bug they
 * would chase in the mixer, not here.
 */
export function createTrack(
  kind: TrackKind,
  options: { readonly id: TrackId; readonly name: string },
): Track {
  const base = {
    id: options.id,
    name: options.name,
    muted: false,
    solo: false,
    locked: false,
    height: DEFAULT_TRACK_HEIGHTS[kind],
    collapsed: false,
    clips: [],
  } as const;

  switch (kind) {
    case 'video':
      return { ...base, kind: 'video', transitions: [] };
    case 'audio':
      // Unity gain, centred: a new track must not alter what the material sounds like.
      return { ...base, kind: 'audio', gain: 1, pan: 0 };
    case 'text':
      return { ...base, kind: 'text' };
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled track kind ${JSON.stringify(unreachable)}`);
    }
  }
}

function lastIndexOfKind(tracks: readonly Track[], kind: TrackKind): number {
  let index = -1;
  for (let position = 0; position < tracks.length; position += 1) {
    if (tracks[position]?.kind === kind) index = position;
  }
  // No track of this kind yet: video goes first, text last, audio between — the order the timeline
  // is read in, so a first audio track never lands above the picture.
  if (index >= 0) return index;
  return kind === 'video' ? -1 : tracks.length - 1;
}
