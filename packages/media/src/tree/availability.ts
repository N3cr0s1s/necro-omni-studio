import type { AssetPath, Clip, ClipId, TimelineDocument } from '@nos/core';
import { clipSource } from '@nos/core';
import { type DirectoryNode, allFiles } from './folder-tree.js';

/**
 * Which of a cut's material is actually on disk.
 *
 * A project is a folder, so its media can leave: a file is renamed outside the editor, a folder is
 * moved, a drive is unplugged. The document keeps a project-relative path either way, which is the
 * right thing for it to keep — but nothing asked whether the path still resolves. A clip whose file
 * had gone drew on the timeline exactly like any other, rendered as nothing, and said nothing. Black
 * frames with no explanation is the worst version of this: the user cannot tell a missing file from a
 * clip that is genuinely dark.
 *
 * This is deliberately a *question about a folder*, not a state stored in the document. Marking clips
 * offline in `project.json` would persist a fact that is only true of one machine at one moment, and
 * would have to be corrected every time the file came back.
 *
 * ## What counts as required
 *
 * Every clip that reads a file. Titles do not, so they are never offline; generated takes do, which is
 * the point — an accepted variant whose file was pruned is exactly the case that used to go silent.
 */

export interface MediaAvailability {
  /** Distinct assets the cut needs that the folder does not have, in first-use order. */
  readonly missing: readonly AssetPath[];
  /** Clips that cannot be drawn, so the timeline can mark them without re-deriving the reason. */
  readonly offlineClips: readonly ClipId[];
  isOffline(clip: ClipId): boolean;
  isMissing(asset: AssetPath): boolean;
}

/** Every asset the cut reads, in the order the timeline first needs it. */
export function requiredAssets(document: TimelineDocument): readonly AssetPath[] {
  const seen = new Set<AssetPath>();
  const assets: AssetPath[] = [];

  for (const track of document.sequence.tracks) {
    for (const clip of track.clips as readonly Clip[]) {
      const source = clipSource(clip);
      if (source === undefined || seen.has(source.asset)) continue;
      seen.add(source.asset);
      assets.push(source.asset);
    }
  }

  return assets;
}

/**
 * What the cut needs against what the folder holds.
 *
 * `tree` of `undefined` means the folder has not been read yet — while a project is opening, or with
 * none open at all — and everything is reported **present**. Announcing that every clip is offline for
 * the second before the first scan lands would be a false alarm at exactly the moment the user is
 * least able to judge it.
 */
export function availabilityOf(
  document: TimelineDocument,
  tree: DirectoryNode | undefined,
): MediaAvailability {
  if (tree === undefined) return present();

  const onDisk = new Set<string>(allFiles(tree).map((file) => file.path));
  const missing = requiredAssets(document).filter((asset) => !onDisk.has(asset));
  if (missing.length === 0) return present();

  const gone = new Set<string>(missing);
  const offlineClips: ClipId[] = [];
  for (const track of document.sequence.tracks) {
    for (const clip of track.clips as readonly Clip[]) {
      const source = clipSource(clip);
      if (source !== undefined && gone.has(source.asset)) offlineClips.push(clip.id);
    }
  }

  const offline = new Set<string>(offlineClips);
  return {
    missing,
    offlineClips,
    isOffline: (clip) => offline.has(clip),
    isMissing: (asset) => gone.has(asset),
  };
}

/** The answer when nothing is missing, shared so the common case allocates one empty shape. */
function present(): MediaAvailability {
  return {
    missing: [],
    offlineClips: [],
    isOffline: () => false,
    isMissing: () => false,
  };
}

/**
 * One line for the status area, or nothing when everything resolves.
 *
 * Names the file when there is one, because "3 clips are offline" sends the user hunting while
 * "media/interview.mp4 is missing" tells them what to look for. The count comes second for the same
 * reason a folder listing shows names before totals.
 */
export function describeAvailability(availability: MediaAvailability): string | undefined {
  const [first, ...rest] = availability.missing;
  if (first === undefined) return undefined;
  return rest.length === 0
    ? `${first} is missing — its clips cannot be drawn`
    : `${first} and ${rest.length} more are missing — their clips cannot be drawn`;
}
