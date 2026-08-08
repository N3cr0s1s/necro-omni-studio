import type { AssetType } from '@nos/core';
import type { DirectoryNode, FileNode, TreeNode } from './folder-tree.js';

/**
 * Narrowing a project folder to what someone is looking for.
 *
 * A project *is* a folder, and a generator fills `generated/` with names like
 * `d318c0ca-5619-4e8c-ac21-09cfd0b4315b_stable_audio_3_00090.flac`. Twenty runs in, finding one take
 * means reading forty of those, and they differ in the middle. Scrolling is not a way to find a file.
 *
 * The rule lives here rather than in the browser component for the reason every rule in this package
 * does: what *matches* is a question about the folder, and it is worth testing without rendering a
 * tree. The component asks for a filtered tree and draws whatever it gets back.
 *
 * ## What matches
 *
 * A **substring of the path**, case-insensitively. The name alone would serve most of it —
 * `stable_audio` finds every take from one generator, `00090` finds one file — but the path is what
 * makes a folder name work as a scope: `generated` with the kind set to audio means "the audio in
 * `generated/`", and matching names alone answered that with nothing, because no file there is called
 * `generated`.
 *
 * Anything cleverer — fuzzy matching, ranking — would reorder a folder the user is navigating
 * spatially, and a file browser that moves things while you type is worse than one that hides them.
 *
 * A **folder survives when anything beneath it does**, so the path to a result is kept and the result
 * is still shown where it lives.
 */

export interface TreeFilter {
  /** Matched case-insensitively against a file's path, so a folder name scopes. Blank matches all. */
  readonly query?: string;
  /** Restricts to one kind of material. Absent means every kind, including files with no type. */
  readonly assetType?: AssetType | undefined;
}

/** Whether a filter would narrow anything at all, so a caller can skip the work and say "all files". */
export function isNarrowing(filter: TreeFilter): boolean {
  return (filter.query ?? '').trim() !== '' || filter.assetType !== undefined;
}

/**
 * The tree, with everything that does not match removed.
 *
 * Returns a directory always — an empty one when nothing matched, because the browser needs somewhere
 * to say "nothing matches" and a caller handed `undefined` would have to invent a root to render.
 *
 * Sizes and counts are **recomputed** for what survived. Leaving the originals would show `generated/`
 * as 47.9 MB while displaying the one file that matched, and a number that contradicts what is on
 * screen is worse than no number.
 */
export function filterTree(root: DirectoryNode, filter: TreeFilter): DirectoryNode {
  if (!isNarrowing(filter)) return root;

  const query = (filter.query ?? '').trim().toLowerCase();
  const kept = keepChildren(root.children, query, filter.assetType);
  return withChildren(root, kept);
}

function keepChildren(
  children: readonly TreeNode[],
  query: string,
  assetType: AssetType | undefined,
): readonly TreeNode[] {
  const kept: TreeNode[] = [];

  for (const child of children) {
    if (child.kind === 'file') {
      if (matchesFile(child, query, assetType)) kept.push(child);
      continue;
    }

    const survivors = keepChildren(child.children, query, assetType);
    if (survivors.length > 0) kept.push(withChildren(child, survivors));
  }

  return kept;
}

function matchesFile(file: FileNode, query: string, assetType: AssetType | undefined): boolean {
  if (assetType !== undefined && file.assetType !== assetType) return false;
  // The path, so that naming a folder narrows to its contents rather than to files called after it.
  return query === '' || file.path.toLowerCase().includes(query);
}

/** A directory carrying different children, with its size and count made to agree with them. */
function withChildren(directory: DirectoryNode, children: readonly TreeNode[]): DirectoryNode {
  let sizeBytes = 0;
  let fileCount = 0;

  for (const child of children) {
    sizeBytes += child.sizeBytes;
    fileCount += child.kind === 'file' ? 1 : child.fileCount;
  }

  return { ...directory, children, sizeBytes, fileCount };
}

/** How many files survived, for a browser that wants to say `3 of 47`. */
export function countFiles(node: DirectoryNode): number {
  return node.fileCount;
}
