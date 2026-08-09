import { type AssetPath, type Clip, type TimelineDocument, clipSource, trackClips } from '@nos/core';
import { replaceTrack, withClips } from './mutate.js';

/**
 * Pointing a cut at media that has moved.
 *
 * The editor can now say that a file has left the folder. Saying so is only half of it: the user's
 * next question is "where did it go", and until this the only answer was to close the editor, put the
 * file back under its old name, and reopen. That is not a repair, it is a workaround for the absence
 * of one.
 *
 * ## By asset, not by clip
 *
 * A relink rewrites **every** clip reading the missing file, because the file moved once and the cut
 * did not change. Offering it per clip would mean fixing a bed used in nine places nine times, and
 * would let eight of them stay broken without saying so.
 *
 * ## Nothing is validated here
 *
 * Whether the replacement exists, whether it is the same kind of media, whether it is even the same
 * length — none of that is decided in this function. It is a document transform, and the caller has
 * the folder. What it *does* guarantee is that a relink either changes something or returns the same
 * document by reference, which is what lets the undo history skip a no-op.
 */

/** Every clip that would be rewritten, so a caller can say how much a relink will touch. */
export function clipsUsing(document: TimelineDocument, asset: AssetPath): readonly Clip[] {
  const using: Clip[] = [];
  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      if (clipSource(clip)?.asset === asset) using.push(clip);
    }
  }
  return using;
}

/**
 * Rewrites every clip reading `from` to read `to` instead.
 *
 * Only the asset changes. The in-point, the rate, the speed and every effect stay exactly as they
 * were, because a relink is a statement about *where the file is*, not about the edit — a user who
 * moved a file into a subfolder has not asked for their trims back.
 *
 * Returns the same document when nothing read `from`, or when the two paths are equal.
 */
export function relinkAsset(document: TimelineDocument, from: AssetPath, to: AssetPath): TimelineDocument {
  if (from === to) return document;

  let next = document;
  for (const track of document.sequence.tracks) {
    const clips = trackClips(track);
    if (!clips.some((clip) => clipSource(clip)?.asset === from)) continue;

    const rewritten = clips.map((clip) => {
      const source = clipSource(clip);
      if (source === undefined || source.asset !== from) return clip;
      return { ...clip, source: { ...source, asset: to } } as Clip;
    });
    next = replaceTrack(next, withClips(track, rewritten));
  }

  return next;
}

/**
 * Files in the folder that could be what a missing asset became.
 *
 * Matched on the **file name**, which is what survives the thing that actually happens: a file moved
 * into a subfolder, or a whole folder reorganised. Matching on content would be better and needs
 * hashes of files the editor may never have read; matching on nothing would make the user hunt.
 *
 * Ranked by how little of the path changed, so a file that moved one folder deep is offered before an
 * unrelated file of the same name elsewhere. A caller with no good candidate should still offer a
 * chooser — the point is to save typing, not to decide.
 */
export function relinkCandidates(missing: AssetPath, present: readonly AssetPath[]): readonly AssetPath[] {
  const wanted = fileName(missing);

  return present
    .filter((candidate) => candidate !== missing && fileName(candidate) === wanted)
    .sort((left, right) => sharedPrefix(right, missing) - sharedPrefix(left, missing));
}

function fileName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/** How many leading characters two paths share, as a cheap "how far did it move". */
function sharedPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let shared = 0;
  while (shared < limit && left[shared] === right[shared]) shared += 1;
  return shared;
}
