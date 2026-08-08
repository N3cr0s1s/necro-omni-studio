import { type AssetPath, type TimelineDocument, clipSource, trackClips } from '@nos/core';

/**
 * Which generated takes nothing is using.
 *
 * The spec leaves unaccepted variants on disk on purpose, so a rejected one can be reconsidered — and
 * nothing ever removes them. A day of generating leaves a `generated/` folder holding sixty files and
 * 63 MB, of which the sequence uses two. That is the intended behaviour producing an unintended
 * outcome: the folder a user browses to find a take is mostly takes they already rejected.
 *
 * A **pure** function over the document and a list of candidates, deliberately not over a folder. What
 * "a generated take" means — a file under `generated/` carrying a provenance record — is the shell's
 * question, because only the shell can read a directory; what "used" means is the document's, and that
 * is the half worth testing without a filesystem.
 *
 * ## What counts as used
 *
 * A clip's source, and a mask's asset. Both are references the document holds to a file on disk, and
 * deleting either would break a project that opens perfectly well today. A file this cannot see a
 * reference to is reported as unused, so the caller must pass **every** candidate it is willing to
 * remove and nothing else — the answer is only as safe as the question.
 */

export interface TakeCandidate {
  readonly path: AssetPath;
  readonly sizeBytes: number;
}

export interface UnusedTakes {
  readonly unused: readonly TakeCandidate[];
  /** How much removing them would reclaim, for a confirmation that states the cost. */
  readonly bytes: number;
  /** Candidates the document still references, so a caller can say `47 of 60`. */
  readonly usedCount: number;
}

export function findUnusedTakes(
  document: TimelineDocument,
  candidates: readonly TakeCandidate[],
): UnusedTakes {
  const referenced = referencedAssets(document);

  const unused = candidates.filter((candidate) => !referenced.has(candidate.path as string));
  const bytes = unused.reduce((total, candidate) => total + candidate.sizeBytes, 0);

  return { unused, bytes, usedCount: candidates.length - unused.length };
}

/**
 * Every file on disk the document points at.
 *
 * Clip sources and mask assets. A text clip has no source and contributes nothing, which is correct —
 * it is drawn rather than read from a file.
 */
export function referencedAssets(document: TimelineDocument): ReadonlySet<string> {
  const assets = new Set<string>();

  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      const source = clipSource(clip);
      if (source !== undefined) assets.add(source.asset as string);
    }
  }

  // Masks are cache, but they are cache the document names — removing one leaves an effect bound to a
  // mask that no longer exists.
  for (const mask of document.masks) assets.add(mask.asset as string);

  return assets;
}
