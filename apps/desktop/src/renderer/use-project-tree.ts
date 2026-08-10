import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DirectoryNode,
  type FileChange,
  type FileEntry,
  type WatcherStatus,
  applyChanges,
  buildTree,
  normalizeChanges,
} from '@nos/media';
import { assetPath } from '@nos/core';
import type { DesktopBridge, FolderEntry } from '../main/ipc-contract.js';
import { bridge } from './bridge.js';

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
 *
 * After the walk, the tree tracks the folder rather than being rebuilt: the main process watches and
 * pushes batches of changes, and each batch is folded into the entry list. Re-walking on every event
 * would mean thousands of IPC round trips while a generator writes a variant set — and the spec's
 * model, that a project *is* a folder, only holds if what the folder does shows up here.
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
          /*
           * Reported as well as walked, which it was not.
           *
           * A folder used to be queued for traversal and dropped, so the only directories the tree
           * ever heard about were the ones it could infer from the *paths of files inside them* — and
           * an **empty folder was invisible**. §4 defines a project as its folder structure and the
           * browser as a view of the real tree; a project whose `media/` had nothing in it yet showed
           * no `media/` at all, which is exactly the moment a user is looking for somewhere to import
           * to. `renders/`, `notes/` and `generated/` were in the same position for the whole life of
           * a project until something happened to write into them.
           *
           * `buildTree` has always had the branch for this — "ensure empty directories still
           * appear" — and nothing could reach it, because no directory entry was ever produced.
           */
          files.push({ path: assetPath(entry.path), sizeBytes: 0, isDirectory: true });
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

  // The flat entry list the tree is built from. Kept because a change batch names paths, and folding
  // a path into a list is cheap where re-deriving one from a nested tree is not.
  const entries = useRef<readonly FileEntry[]>([]);

  const refresh = useCallback(() => {
    const api = bridge();
    if (api === undefined || root === undefined) {
      entries.current = [];
      setTree(undefined);
      return;
    }

    void walkProject(api)
      .then((result) => {
        entries.current = result.entries;
        setTree(buildTree(result.entries));
        setTruncated(result.truncated);
      })
      .catch((error: unknown) => {
        // A failed scan leaves no tree, and says so. Silently keeping the previous one would be worse:
        // the user would act on a listing of a folder that may no longer exist.
        setWatcher({
          watching: false,
          error: { kind: 'failed', detail: error instanceof Error ? error.message : String(error) },
        });
      });
  }, [root]);

  useEffect(refresh, [refresh]);

  // The watcher's own report, not an inference from "the scan worked". Before this the browser said
  // "watching" whenever a scan had succeeded, which was true of a folder nothing was watching at all.
  useEffect(() => {
    const api = bridge();
    if (api === undefined || root === undefined) {
      setWatcher({ watching: false });
      return;
    }

    // Primed from the current state, then kept up to date. The watcher starts while the project is
    // being opened, so its first report is sent before this subscription exists.
    let live = true;
    void api.watcherStatus().then((current) => {
      if (live) setWatcher(current);
    });

    const stopStatus = api.onWatcherStatus(setWatcher);
    const stopChanges = api.onProjectChanged((changes: readonly FileChange[]) => {
      const visible = normalizeChanges(changes);
      if (visible.length === 0) return;

      entries.current = applyChanges(entries.current, visible);
      setTree(buildTree(entries.current));
    });

    return () => {
      live = false;
      stopStatus();
      stopChanges();
    };
  }, [root]);

  return { tree, watcher, truncated, refresh };
}
