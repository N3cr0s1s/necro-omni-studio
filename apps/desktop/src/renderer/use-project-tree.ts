import { useCallback, useEffect, useState } from 'react';
import { type DirectoryNode, type FileEntry, type WatcherStatus, buildTree } from '@nos/media';
import { assetPath } from '@nos/core';
import type { DesktopBridge, FolderEntry } from '../main/ipc-contract.js';

/**
 * The project folder tree.
 *
 * Walks the folder through the IPC bridge and builds the same `DirectoryNode` the media browser is
 * written against, so the browser stays a pure rendering of a value and never learns that Electron
 * exists.
 *
 * The walk is breadth-first with a depth cap. A project folder is user-controlled and can contain a
 * `node_modules`, a symlink loop or a hundred thousand cache files; an uncapped recursive walk turns
 * opening a project into a hang with no explanation.
 */

/** Deep enough for `media/shoot-2/day-1/a.mp4`, shallow enough that a stray tree cannot hang the open. */
export const MAX_TREE_DEPTH = 6;

/** Above this the tree is truncated and the browser says so, rather than freezing. */
export const MAX_TREE_ENTRIES = 20_000;

export interface ProjectTree {
  readonly tree: DirectoryNode | undefined;
  readonly watcher: WatcherStatus;
  readonly truncated: boolean;
  refresh(): void;
}

function bridge(): DesktopBridge | undefined {
  return (globalThis as { nos?: DesktopBridge }).nos;
}

export async function walkProject(
  api: DesktopBridge,
  maxEntries = MAX_TREE_ENTRIES,
  maxDepth = MAX_TREE_DEPTH,
): Promise<{ entries: readonly FileEntry[]; truncated: boolean }> {
  const files: FileEntry[] = [];
  let queue: readonly { path: string; depth: number }[] = [{ path: '', depth: 0 }];
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const next: { path: string; depth: number }[] = [];

    for (const folder of queue) {
      const listing = await api.listFolder(folder.path).catch((): readonly FolderEntry[] => []);
      for (const entry of listing) {
        if (files.length >= maxEntries) {
          truncated = true;
          break;
        }
        if (entry.kind === 'folder') {
          if (folder.depth + 1 <= maxDepth) next.push({ path: entry.path, depth: folder.depth + 1 });
          continue;
        }
        files.push({
          path: assetPath(entry.path),
          sizeBytes: entry.sizeBytes ?? 0,
          isDirectory: false,
        });
      }
      if (truncated) break;
    }
    queue = next;
  }

  return { entries: files, truncated };
}

export function useProjectTree(root: string | undefined): ProjectTree {
  const [tree, setTree] = useState<DirectoryNode | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [watcher, setWatcher] = useState<WatcherStatus>({ watching: false });

  const refresh = useCallback(() => {
    const api = bridge();
    if (api === undefined || root === undefined) {
      setTree(undefined);
      setWatcher({ watching: false });
      return;
    }

    void walkProject(api)
      .then((result) => {
        setTree(buildTree(result.entries));
        setTruncated(result.truncated);
        setWatcher({ watching: true });
      })
      .catch((error: unknown) => {
        // A dead watcher is reported, never silent: the user would otherwise trust a stale tree, which
        // is worse than having no tree at all.
        setWatcher({
          watching: false,
          error: { kind: 'failed', detail: error instanceof Error ? error.message : String(error) },
        });
      });
  }, [root]);

  useEffect(refresh, [refresh]);

  return { tree, watcher, truncated, refresh };
}
