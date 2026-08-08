import { type AssetPath, PROJECT_FOLDERS, assetPath } from '@nos/core';
import { type AssetType, classifyAsset, fileName, parentPath } from '../contracts/media-kind.js';
import { type FileChange, isCacheContent, isIgnoredPath } from '../contracts/watcher.js';

/**
 * The media browser's model of the project folder.
 *
 * Built from a flat list of paths rather than by walking a nested structure, because that is
 * what both a directory scan and a watcher batch produce. Rebuilding from flat input is also
 * what makes applying a change batch straightforward: update the flat set, rebuild, diff by
 * reference.
 *
 * Immutable. The browser re-renders from a new tree rather than mutating nodes in place, so
 * React can compare node references to decide what actually changed.
 */

export interface FileNode {
  readonly kind: 'file';
  readonly path: AssetPath;
  readonly name: string;
  readonly assetType: AssetType | undefined;
  readonly sizeBytes: number;
  readonly modifiedAt: number | undefined;
}

export interface DirectoryNode {
  readonly kind: 'directory';
  readonly path: AssetPath | '';
  readonly name: string;
  readonly children: readonly TreeNode[];
  /**
   * Total size of everything beneath, recursively.
   *
   * Precomputed because the spec requires the browser to show `generated/` with its size, and
   * recomputing it per render while a generator writes into it would be wasteful.
   */
  readonly sizeBytes: number;
  /** Direct + transitive file count, for a "9 generators" style badge. */
  readonly fileCount: number;
}

export type TreeNode = FileNode | DirectoryNode;

export interface FileEntry {
  readonly path: AssetPath;
  readonly sizeBytes: number;
  readonly modifiedAt?: number;
  readonly isDirectory: boolean;
}

/**
 * Sort order within a directory.
 *
 * Directories first, then files, each alphabetically and case-insensitively. Reserved project
 * folders are pinned above user-created ones in their conventional order, because the browser
 * is a workspace the user navigates by muscle memory — `media` should not move below a
 * directory someone named `archive`.
 */
const FOLDER_ORDER: readonly string[] = [
  PROJECT_FOLDERS.media,
  PROJECT_FOLDERS.generated,
  PROJECT_FOLDERS.masks,
  PROJECT_FOLDERS.effects,
  PROJECT_FOLDERS.generators,
  PROJECT_FOLDERS.notes,
  PROJECT_FOLDERS.renders,
  PROJECT_FOLDERS.cache,
];

function folderRank(name: string): number {
  const index = FOLDER_ORDER.indexOf(name);
  return index < 0 ? FOLDER_ORDER.length : index;
}

/**
 * The timeline document. Pinned above everything else in the folder it lives in.
 *
 * It is the one file that *is* the project, so it belongs at the top even though the general rule
 * puts directories before files — this matches the mockups, where it sits above `media/`.
 */
const PROJECT_DOCUMENT_NAME = 'project.json';

/**
 * Orders the children of one directory.
 *
 * `atRoot` matters: only the root's `project.json` is *the* project document. A file with that name
 * inside `notes/` is an ordinary file and must not jump the queue, so the pin cannot live in a
 * depth-blind comparator.
 */
function compareNodes(a: TreeNode, b: TreeNode, atRoot: boolean): number {
  if (atRoot) {
    const aIsDocument = a.kind === 'file' && a.name === PROJECT_DOCUMENT_NAME;
    const bIsDocument = b.kind === 'file' && b.name === PROJECT_DOCUMENT_NAME;
    if (aIsDocument !== bIsDocument) return aIsDocument ? -1 : 1;
  }

  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  if (a.kind === 'directory' && b.kind === 'directory') {
    const rankDelta = folderRank(a.name) - folderRank(b.name);
    if (rankDelta !== 0) return rankDelta;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
}

/**
 * Builds the tree from a flat entry list.
 *
 * Intermediate directories are synthesized from paths, so a scan that reports only files
 * still produces a correct tree. Cache contents and ignored files are filtered here, in one
 * place, rather than at every call site that touches the tree.
 */
export function buildTree(entries: readonly FileEntry[]): DirectoryNode {
  interface MutableDirectory {
    readonly name: string;
    readonly path: string;
    readonly directories: Map<string, MutableDirectory>;
    readonly files: FileNode[];
  }

  const root: MutableDirectory = {
    name: '',
    path: '',
    directories: new Map(),
    files: [],
  };

  function directoryFor(path: string): MutableDirectory {
    if (path === '') return root;
    const segments = path.split('/');
    let current = root;
    let walked = '';
    for (const segment of segments) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      let next = current.directories.get(segment);
      if (next === undefined) {
        next = { name: segment, path: walked, directories: new Map(), files: [] };
        current.directories.set(segment, next);
      }
      current = next;
    }
    return current;
  }

  for (const entry of entries) {
    if (isIgnoredPath(entry.path)) continue;
    if (isCacheContent(entry.path)) continue;

    if (entry.isDirectory) {
      // Ensure empty directories still appear; the spec allows arbitrary structure and an
      // empty `renders/` is meaningful information.
      directoryFor(entry.path);
      continue;
    }

    const parent = directoryFor(parentPath(entry.path));
    parent.files.push({
      kind: 'file',
      path: entry.path,
      name: fileName(entry.path),
      assetType: classifyAsset(entry.path),
      sizeBytes: entry.sizeBytes,
      ...(entry.modifiedAt !== undefined ? { modifiedAt: entry.modifiedAt } : { modifiedAt: undefined }),
    });
  }

  function freeze(directory: MutableDirectory): DirectoryNode {
    const childDirectories = [...directory.directories.values()].map(freeze);
    const atRoot = directory.path === '';
    const children: TreeNode[] = [...childDirectories, ...directory.files].sort((a, b) =>
      compareNodes(a, b, atRoot),
    );

    let sizeBytes = 0;
    let fileCount = 0;
    for (const child of children) {
      sizeBytes += child.sizeBytes;
      fileCount += child.kind === 'directory' ? child.fileCount : 1;
    }

    return {
      kind: 'directory',
      path: directory.path === '' ? '' : assetPath(directory.path),
      name: directory.name,
      children,
      sizeBytes,
      fileCount,
    };
  }

  return freeze(root);
}

/**
 * Applies a watcher batch to a flat entry set.
 *
 * Kept separate from `buildTree` so the caller owns the flat set and the tree is a pure
 * projection of it. A `removed` directory also removes everything beneath it, which a
 * watcher does not always report per child.
 */
export function applyChanges(
  entries: readonly FileEntry[],
  changes: readonly FileChange[],
): readonly FileEntry[] {
  const byPath = new Map<string, FileEntry>(entries.map((entry) => [entry.path, entry]));

  for (const change of changes) {
    if (change.kind === 'removed') {
      byPath.delete(change.path);
      if (change.isDirectory) {
        const prefix = `${change.path}/`;
        for (const key of [...byPath.keys()]) {
          if (key.startsWith(prefix)) byPath.delete(key);
        }
      }
      continue;
    }

    const existing = byPath.get(change.path);
    byPath.set(change.path, {
      path: change.path,
      isDirectory: change.isDirectory,
      sizeBytes: change.sizeBytes ?? existing?.sizeBytes ?? 0,
      ...(change.modifiedAt !== undefined
        ? { modifiedAt: change.modifiedAt }
        : existing?.modifiedAt !== undefined
          ? { modifiedAt: existing.modifiedAt }
          : {}),
    });
  }

  return [...byPath.values()];
}

/** Depth-first walk in display order. */
export function* walkTree(node: DirectoryNode): Generator<TreeNode> {
  for (const child of node.children) {
    yield child;
    if (child.kind === 'directory') yield* walkTree(child);
  }
}

export function findNode(root: DirectoryNode, path: string): TreeNode | undefined {
  if (path === '') return root;
  for (const node of walkTree(root)) {
    if (node.path === path) return node;
  }
  return undefined;
}

export function allFiles(root: DirectoryNode): readonly FileNode[] {
  const files: FileNode[] = [];
  for (const node of walkTree(root)) {
    if (node.kind === 'file') files.push(node);
  }
  return files;
}

export function filesOfType(root: DirectoryNode, type: AssetType): readonly FileNode[] {
  return allFiles(root).filter((file) => file.assetType === type);
}

/**
 * Human-readable byte size, matching the mockups' `2.41 GB`.
 *
 * Binary units with decimal labels, which is the convention every file manager on the target
 * platforms uses; being technically correct with `GiB` here would just look wrong next to the
 * OS.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${units[unit]}`;
}
