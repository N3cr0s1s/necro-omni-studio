import {
  type AssetPath,
  type AssetType,
  type AudioClip,
  type Clip,
  type ClipId,
  type FrameIndex,
  type FrameRate,
  type ImageClip,
  type Result,
  type TimelineDocument,
  type Track,
  type TrackId,
  type VideoClip,
  endExclusive,
  err,
  frameIndex,
  frameRateToNumber,
  ok,
  overlaps,
  spanFromBounds,
  staticNumber,
} from '@nos/core';
import type { EditError } from './errors.js';
import { replaceTrack } from './mutate.js';

/**
 * Bringing media onto the timeline.
 *
 * The spec's rule that shapes this: **a video whose file carries audio appears as a video clip with a
 * linked audio clip beneath it.** The link is explicit rather than inferred from matching asset paths,
 * because two cuts of the same file must not appear linked — inferring it would tie together clips the
 * user deliberately separated.
 *
 * Everything else follows from what the file is. Timed media takes its length from the probe; a still
 * has no intrinsic length, so it takes an authored one. Frames come from the *project's* rate, since
 * that is the document's time base — the source's own rate is kept on the clip for the retime, not used
 * for placement.
 *
 * Pure, like every operation here: the caller supplies the ids and the metadata, so the same import
 * always produces the same document.
 */

export interface ImportMediaRequest {
  readonly asset: AssetPath;
  readonly type: AssetType;
  /**
   * From the probe. Absent for a still, which has no intrinsic length.
   *
   * Written `| undefined` rather than left optional so a caller can pass an absent probe result through
   * without a conditional spread at every site — an import assembles its request from several sources
   * and most of them are legitimately unknown.
   */
  readonly durationSeconds?: number | undefined;
  /** The file's own rate, kept on the clip so a retime is exact. Defaults to the project's. */
  readonly sourceRate?: FrameRate | undefined;
  /** True when the file carries an audio stream the importer should split out. */
  readonly hasAudio?: boolean | undefined;
  readonly at: FrameIndex;
  readonly videoTrack: TrackId;
  readonly audioTrack: TrackId;
  readonly label: string;
  /** Ids the caller supplies, so the operation stays pure and its output diffable. */
  readonly id: ClipId;
  readonly linkedId?: ClipId | undefined;
  /** Frames a still occupies. Ignored for timed media. */
  readonly stillFrames?: number | undefined;
}

export interface ImportMediaResult {
  readonly document: TimelineDocument;
  /** The clips created, picture first. */
  readonly clips: readonly Clip[];
}

/** How long a still image lasts by default: five seconds, the length a viewer reads a card. */
export const DEFAULT_STILL_SECONDS = 5;

export function importMedia(
  document: TimelineDocument,
  request: ImportMediaRequest,
): Result<ImportMediaResult, EditError> {
  const rate = document.frameRate;
  const frames = lengthInFrames(request, rate);
  if (frames <= 0) return err({ kind: 'empty-result', clip: request.id });

  const span = spanFromBounds(request.at, frameIndex(request.at + frames));
  const source = {
    asset: request.asset,
    sourceIn: frameIndex(0),
    sourceRate: request.sourceRate ?? rate,
  };

  // Audio-only files never touch the picture track, and a still is a picture with no sound. Only a
  // video can produce a pair, and only when the file actually carries a stream.
  const wantsPicture = request.type === 'video' || request.type === 'image';
  const wantsSound = request.type === 'audio' || (request.type === 'video' && request.hasAudio === true);
  if (!wantsPicture && !wantsSound) {
    return err({
      kind: 'wrong-track-kind',
      track: request.videoTrack,
      accepts: ['video', 'audio'],
      received: request.type,
    });
  }

  const pictureTrack = wantsPicture ? findTrack(document, request.videoTrack, 'video') : undefined;
  const soundTrack = wantsSound ? findTrack(document, request.audioTrack, 'audio') : undefined;

  if (wantsPicture && pictureTrack === undefined) {
    return err({ kind: 'track-not-found', track: request.videoTrack });
  }
  if (wantsSound && soundTrack === undefined) {
    return err({ kind: 'track-not-found', track: request.audioTrack });
  }

  for (const track of [pictureTrack, soundTrack]) {
    if (track === undefined) continue;
    if (track.locked) return err({ kind: 'track-locked', track: track.id });

    const blocking = (track.clips as readonly Clip[]).find((clip) => overlaps(clip.span, span));
    if (blocking !== undefined) {
      // Rejected, not displaced. Silently moving material the user cannot see is the single most
      // destructive thing a timeline can do, and an import is no exception.
      return err({ kind: 'collision', track: track.id, withClip: blocking.id });
    }
  }

  // A pair needs two ids, and the caller supplies them: generating one here would make the same import
  // produce a different document each time, which undo comparison and a saved file both notice.
  const pairedAudioId = wantsPicture && wantsSound ? request.linkedId : undefined;
  if (wantsPicture && wantsSound && pairedAudioId === undefined) {
    return err({ kind: 'clip-not-found', clip: request.id });
  }

  const clips: Clip[] = [];
  let next = document;

  if (pictureTrack !== undefined) {
    const picture: VideoClip | ImageClip =
      request.type === 'image'
        ? {
            kind: 'image',
            id: request.id,
            span,
            label: request.label,
            enabled: true,
            effects: [],
            source,
            transform: neutralTransform(),
          }
        : {
            kind: 'video',
            id: request.id,
            span,
            label: request.label,
            enabled: true,
            effects: [],
            source,
            transform: neutralTransform(),
            speed: { factor: 1, preservePitch: true },
            ...(pairedAudioId !== undefined ? { linkedAudio: pairedAudioId } : {}),
          };

    clips.push(picture);
    next = replaceTrack(next, { ...pictureTrack, clips: [...pictureTrack.clips, picture] } as Track);
  }

  if (soundTrack !== undefined) {
    const soundId = pairedAudioId ?? request.id;
    const sound: AudioClip = {
      kind: 'audio',
      id: soundId,
      span,
      label: request.label,
      enabled: true,
      effects: [],
      source,
      speed: { factor: 1, preservePitch: true },
      gain: staticNumber(1),
      pan: staticNumber(0),
      ...(pairedAudioId !== undefined ? { linkedVideo: request.id } : {}),
    };

    clips.push(sound);
    // Re-read the track from the updated document: adding the picture rebuilt the track list, and
    // writing the stale one back would drop the clip that was just inserted.
    const current = findTrack(next, soundTrack.id, 'audio') ?? soundTrack;
    next = replaceTrack(next, { ...current, clips: [...current.clips, sound] } as Track);
  }

  return ok({ document: next, clips });
}

/**
 * Where an import can land without displacing anything.
 *
 * Offered so a caller can place at the playhead when it is free and append otherwise, rather than
 * making the user find a gap by hand. Returns the playhead unchanged when it is clear.
 */
export function firstFreeFrame(
  document: TimelineDocument,
  tracks: readonly TrackId[],
  from: FrameIndex,
  frames: number,
): FrameIndex {
  let candidate = from;

  // Each pass may push past a clip that the previous pass cleared, so it repeats until a whole span
  // fits on every track at once.
  for (let guard = 0; guard < 1000; guard += 1) {
    const span = spanFromBounds(candidate, frameIndex(candidate + frames));
    let moved = false;

    for (const trackId of tracks) {
      const track = document.sequence.tracks.find((entry) => entry.id === trackId);
      if (track === undefined) continue;

      for (const clip of track.clips as readonly Clip[]) {
        if (!overlaps(clip.span, span)) continue;
        candidate = endExclusive(clip.span);
        moved = true;
        break;
      }
      if (moved) break;
    }

    if (!moved) return candidate;
  }
  return candidate;
}

/** Frames the clip occupies, from the probe or from the still default. */
function lengthInFrames(request: ImportMediaRequest, rate: FrameRate): number {
  if (request.type === 'image') {
    return Math.max(1, request.stillFrames ?? Math.round(DEFAULT_STILL_SECONDS * frameRateToNumber(rate)));
  }
  const seconds = request.durationSeconds ?? 0;
  return Math.max(0, Math.round(seconds * frameRateToNumber(rate)));
}

function findTrack(
  document: TimelineDocument,
  id: TrackId,
  kind: 'video' | 'audio',
): Extract<Track, { kind: typeof kind }> | undefined {
  const found = document.sequence.tracks.find((track) => track.id === id && track.kind === kind);
  return found as Extract<Track, { kind: typeof kind }> | undefined;
}

function neutralTransform(): VideoClip['transform'] {
  return {
    x: staticNumber(0),
    y: staticNumber(0),
    scale: staticNumber(1),
    rotation: staticNumber(0),
    opacity: staticNumber(1),
  };
}
