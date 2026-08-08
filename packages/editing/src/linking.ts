import {
  type Clip,
  type ClipId,
  type Result,
  type TimelineDocument,
  err,
  linkedPartner,
  locateClip,
  ok,
} from '@nos/core';
import type { EditError } from './errors.js';
import { replaceClip, replaceTrack } from './mutate.js';

/**
 * The link between a video clip and the audio split out of the same file.
 *
 * Import has recorded the link since M3 and editing has honoured it since this morning — a drag on
 * either reaches both. What was missing is everything a user does *with* a link: seeing that it is
 * there, and breaking it when the sound needs to run past the picture, which is one of the most
 * common cuts there is.
 *
 * The link is **explicit and symmetric**: each side names the other. It is never inferred from
 * matching asset paths, because two cuts of the same file must not appear linked — a rule the
 * document model has stated since M1 and which unlinking would quietly undo if the link were
 * derived rather than stored.
 */

/**
 * Breaks the link on both sides.
 *
 * Both, always: a one-sided link is worse than none, because every operation that follows one would
 * behave differently depending on which half the user happened to grab.
 */
export function unlinkClips(document: TimelineDocument, clip: ClipId): Result<TimelineDocument, EditError> {
  const located = locateClip(document, clip);
  if (located === undefined) return err({ kind: 'clip-not-found', clip });

  const partner = linkedPartner(located.clip);
  if (partner === undefined) return ok(document);

  let next = replaceTrack(document, replaceClip(located.track, withoutLink(located.clip)));

  const other = locateClip(next, partner);
  if (other !== undefined) {
    next = replaceTrack(next, replaceClip(other.track, withoutLink(other.clip)));
  }
  return ok(next);
}

/**
 * Links a video clip to an audio clip.
 *
 * Refused when either is already linked to something else, rather than silently stealing a partner:
 * the clip left behind would keep a link naming a clip that no longer names it, which is the
 * one-sided state `unlinkClips` exists to make impossible.
 */
export function linkClips(
  document: TimelineDocument,
  video: ClipId,
  audio: ClipId,
): Result<TimelineDocument, EditError> {
  const videoSide = locateClip(document, video);
  const audioSide = locateClip(document, audio);
  if (videoSide === undefined) return err({ kind: 'clip-not-found', clip: video });
  if (audioSide === undefined) return err({ kind: 'clip-not-found', clip: audio });

  if (videoSide.clip.kind !== 'video') {
    return err({
      kind: 'wrong-track-kind',
      track: videoSide.track.id,
      accepts: ['video'],
      received: videoSide.clip.kind,
    });
  }
  if (audioSide.clip.kind !== 'audio') {
    return err({
      kind: 'wrong-track-kind',
      track: audioSide.track.id,
      accepts: ['audio'],
      received: audioSide.clip.kind,
    });
  }

  const videoPartner = linkedPartner(videoSide.clip);
  const audioPartner = linkedPartner(audioSide.clip);
  if (
    (videoPartner !== undefined && videoPartner !== audio) ||
    (audioPartner !== undefined && audioPartner !== video)
  ) {
    return err({ kind: 'already-linked', clip: videoPartner === undefined ? audio : video });
  }

  const videoClip = videoSide.clip;
  const withVideo = replaceTrack(
    document,
    replaceClip(videoSide.track, { ...videoClip, linkedAudio: audio }),
  );
  const freshAudio = locateClip(withVideo, audio);
  if (freshAudio === undefined || freshAudio.clip.kind !== 'audio') {
    return err({ kind: 'clip-not-found', clip: audio });
  }

  return ok(
    replaceTrack(withVideo, replaceClip(freshAudio.track, { ...freshAudio.clip, linkedVideo: video })),
  );
}

function withoutLink(clip: Clip): Clip {
  if (clip.kind === 'video') {
    const { linkedAudio: _dropped, ...rest } = clip;
    return rest as Clip;
  }
  if (clip.kind === 'audio') {
    const { linkedVideo: _dropped, ...rest } = clip;
    return rest as Clip;
  }
  return clip;
}
