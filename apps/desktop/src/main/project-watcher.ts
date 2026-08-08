import { type FSWatcher, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { FileChange, WatcherError } from '@nos/media';

/**
 * Watching the project folder.
 *
 * The spec's model is that a project **is** a folder, which only holds if the application notices
 * what happens to that folder. A generator writes into `generated/`, the user drops footage in with
 * a file manager, an external tool rewrites a note — before this, none of it appeared until the
 * project was reopened, while the browser cheerfully reported "watching".
 *
 * Lives in the main process because it is filesystem work and because the renderer is the untrusted
 * side of the boundary. What crosses it is a batch of project-relative changes, never a raw path.
 *
 * The policy — what to hide, how to collapse a burst, how the tree absorbs a batch — is `@nos/media`
 * and is tested there. This module's job is narrower and entirely about the platform: turn `fs.watch`
 * events into that vocabulary without lying about what happened.
 */

export interface ProjectWatcherHandle {
  close(): void;
}

export interface WatchCallbacks {
  onChanges(changes: readonly FileChange[]): void;
  onError(error: WatcherError): void;
}

/**
 * Debounce window.
 *
 * Mirrors `WATCH_DEBOUNCE_MS` in `@nos/media` rather than importing it, because the two are the same
 * number for different reasons: there it is how long the UI waits before re-rendering, here it is how
 * long to wait for a file to finish being written before asking the filesystem about it. Coupling
 * them would make one of the two impossible to tune.
 */
const SETTLE_MS = 120;

/**
 * Starts watching, recursively.
 *
 * Recursive watching is a platform feature and not a universal one, so a failure to start is
 * reported rather than thrown: the browser then shows an unwatched project with a refresh button,
 * which is honest, instead of a "watching" indicator over a tree that has stopped tracking reality.
 */
export function watchProject(root: string, callbacks: WatchCallbacks): ProjectWatcherHandle {
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: false });
  } catch (error) {
    callbacks.onError(describeStartFailure(error));
    return { close: () => undefined };
  }

  // Paths seen since the last flush. A set, because a single save fires several events for one file
  // and the filesystem is asked about each path exactly once.
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  async function flush(): Promise<void> {
    timer = undefined;
    const paths = [...pending];
    pending.clear();

    const described = (await Promise.all(paths.map((path) => describeChange(root, path)))).filter(
      (change): change is FileChange => change !== undefined,
    );

    // A directory that just appeared is expanded into its contents. The recursive watcher registers
    // its interest in a new subdirectory only once it has seen it, so anything written into it in
    // that window arrives with no event at all — which is exactly what a generator does when it
    // creates an output folder and immediately fills it.
    const nested = await Promise.all(
      described
        .filter((change) => change.kind === 'added' && change.isDirectory)
        .map((change) => listSubtree(root, change.path)),
    );

    const all = [...described, ...nested.flat()];
    if (all.length > 0 && !closed) callbacks.onChanges(all);
  }

  watcher.on('change', (_event, filename) => {
    const relative = toRelative(filename);
    if (relative === undefined) return;
    pending.add(relative);
    // Restarted rather than left running: a copy of two hundred files should produce one batch when
    // it finishes, not a batch every 120 ms while the disk is busy.
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void flush(), SETTLE_MS);
  });

  watcher.on('error', (error) => {
    callbacks.onError({ kind: 'failed', detail: error.message });
  });

  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
    },
  };
}

/**
 * Asks the filesystem what a path is now.
 *
 * `fs.watch` reports that *something* happened, never what — a rename event fires for a create, a
 * delete and a move alike. Statting is the only way to tell them apart, and doing it after the
 * settle window means a file written in several chunks is reported once, at its final size.
 */
async function describeChange(root: string, relative: string): Promise<FileChange | undefined> {
  try {
    const info = await stat(join(root, relative));
    return {
      // `added` for anything that exists: the tree treats an add of a known path as an update, so
      // guessing between "added" and "changed" would buy nothing and could be wrong.
      kind: 'added',
      path: relative as FileChange['path'],
      isDirectory: info.isDirectory(),
      sizeBytes: info.size,
      modifiedAt: info.mtimeMs,
    };
  } catch {
    // Gone by the time it was asked about. That is a removal from the tree's point of view whether
    // the file was deleted, renamed away, or never finished being written.
    return { kind: 'removed', path: relative as FileChange['path'], isDirectory: false };
  }
}

/**
 * Everything inside a directory, as change events.
 *
 * Bounded, because the directory is user-controlled: an unzipped archive or a symlinked tree could
 * otherwise turn one event into an unbounded walk while the user is editing. Past the cap the
 * remaining files simply arrive later, when the watcher notices them itself.
 */
const SUBTREE_ENTRY_BUDGET = 2000;

async function listSubtree(root: string, relative: string): Promise<readonly FileChange[]> {
  try {
    const entries = await readdir(join(root, relative), { recursive: true, withFileTypes: true });

    const changes: FileChange[] = [];
    for (const entry of entries.slice(0, SUBTREE_ENTRY_BUDGET)) {
      const path = `${relative}/${entry.name}`;
      const info = await stat(join(root, path)).catch(() => undefined);
      if (info === undefined) continue;
      changes.push({
        kind: 'added',
        path: path as FileChange['path'],
        isDirectory: info.isDirectory(),
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
      });
    }
    return changes;
  } catch {
    // Vanished, or unreadable. Either way there is nothing to report about its contents.
    return [];
  }
}

/**
 * Normalizes a watcher filename to a project-relative path.
 *
 * Forward slashes on every platform, because asset identity is a project-relative path and a project
 * authored on Windows must open on Linux with the same identities.
 */
export function toRelative(filename: string | Buffer | null): string | undefined {
  if (filename === null) return undefined;
  const text = typeof filename === 'string' ? filename : filename.toString('utf8');
  if (text === '') return undefined;
  return text.split(sep).join('/');
}

export function describeStartFailure(error: unknown): WatcherError {
  const code = (error as { code?: string } | undefined)?.code;
  const detail = error instanceof Error ? error.message : String(error);

  switch (code) {
    case 'ENOENT':
      return { kind: 'root-missing', detail };
    case 'EACCES':
    case 'EPERM':
      return { kind: 'permission-denied', detail };
    case 'ENOSPC':
      // The inotify watch limit, which is the failure a large project actually hits on Linux — and
      // one whose real cause is unguessable from the raw message.
      return { kind: 'limit-exceeded', detail };
    default:
      return { kind: 'failed', detail };
  }
}
