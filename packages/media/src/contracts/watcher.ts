import type { AssetPath } from '@nos/core';

/**
 * Project folder watching.
 *
 * The spec requires the media browser to mirror the real folder tree with a watcher, and to
 * accept arbitrary subdirectories and file types. That makes the filesystem — not a database
 * — the source of truth, so the browser must react to changes made outside the app: a
 * generator writing into `generated/`, the user dropping files in with a file manager, an
 * external tool rewriting a note.
 */

export type FileChangeKind = 'added' | 'changed' | 'removed';

export interface FileChange {
  readonly kind: FileChangeKind;
  readonly path: AssetPath;
  readonly isDirectory: boolean;
  /** Absent for `removed`. */
  readonly sizeBytes?: number;
  readonly modifiedAt?: number;
}

/**
 * A batch of changes.
 *
 * Batched rather than per-event because the interesting cases arrive in bursts — a generator
 * writing a variant set, an unzip, a copy of a hundred files. Re-rendering the tree per file
 * would blow the spec's 16 ms interaction budget for the duration of the burst.
 */
export interface FileChangeBatch {
  readonly changes: readonly FileChange[];
}

export type WatcherError =
  | { readonly kind: 'root-missing'; readonly detail: string }
  | { readonly kind: 'permission-denied'; readonly detail: string }
  | { readonly kind: 'limit-exceeded'; readonly detail: string }
  | { readonly kind: 'failed'; readonly detail: string };

export interface WatcherStatus {
  readonly watching: boolean;
  readonly error?: WatcherError;
}

/**
 * Watches the project folder.
 *
 * `status` is surfaced deliberately: the mockups show a live "watching" indicator, and a
 * silently dead watcher is worse than none — the user would trust a stale tree. When the
 * watcher fails, the UI must say so and offer a manual refresh.
 */
export interface ProjectWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): WatcherStatus;
  onChange(listener: (batch: FileChangeBatch) => void): () => void;
  onStatusChange(listener: (status: WatcherStatus) => void): () => void;
  /** Forces a full rescan, for recovery after a watcher failure. */
  rescan(): Promise<void>;
}

/**
 * Debounce window for coalescing a burst of filesystem events.
 *
 * Long enough that writing a file (create, then one or more writes, then close) collapses to
 * a single change, short enough that a generator's output appears effectively immediately.
 */
export const WATCH_DEBOUNCE_MS = 120;

/**
 * Files that must never surface in the browser.
 *
 * `project.json` is shown because it is meaningful to the user, and `cache/` is shown as a
 * folder with its size so the user can judge whether to clear it — but the individual
 * derived files inside are noise. Editor and OS droppings are hidden outright.
 */
const IGNORED_NAMES: readonly string[] = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep'];

const IGNORED_PREFIXES: readonly string[] = ['~$', '.#'];
const IGNORED_SUFFIXES: readonly string[] = ['.tmp', '.part', '.crdownload', '.swp'];

/**
 * Whether a path should be hidden from the browser.
 *
 * Partial-write suffixes matter more than they look: a watcher fires while a large generator
 * output is still being written, and showing a `.part` file invites the user to drag an
 * incomplete asset onto the timeline.
 */
export function isIgnoredPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (IGNORED_NAMES.includes(name)) return true;
  if (IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (IGNORED_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))) return true;
  return false;
}

/**
 * Whether a path is inside the derived cache.
 *
 * The `cache/` directory entry itself is not hidden — only its contents — because the spec
 * requires the browser to show the folder and its size.
 */
export function isCacheContent(path: string): boolean {
  return path.startsWith('cache/') && path.length > 'cache/'.length;
}

/**
 * Collapses a burst of events into the minimum set the UI needs.
 *
 * Per path, the last event wins, with one exception that matters: `added` followed by
 * `changed` stays `added`, because the tree has not seen the file yet and reporting a change
 * to an unknown node would be dropped. Conversely `added` followed by `removed` cancels out
 * entirely — a temporary file that appeared and vanished within the debounce window should
 * never reach the UI at all.
 */
export function coalesceChanges(changes: readonly FileChange[]): readonly FileChange[] {
  const byPath = new Map<string, FileChange>();

  for (const change of changes) {
    const existing = byPath.get(change.path);
    if (existing === undefined) {
      byPath.set(change.path, change);
      continue;
    }
    if (existing.kind === 'added' && change.kind === 'removed') {
      byPath.delete(change.path);
      continue;
    }
    if (existing.kind === 'added' && change.kind === 'changed') {
      byPath.set(change.path, { ...change, kind: 'added' });
      continue;
    }
    byPath.set(change.path, change);
  }

  return [...byPath.values()];
}

/** Drops changes the browser must not show, then coalesces the rest. */
export function normalizeChanges(changes: readonly FileChange[]): readonly FileChange[] {
  const visible = changes.filter((change) => !isIgnoredPath(change.path) && !isCacheContent(change.path));
  return coalesceChanges(visible);
}
