import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { type AppSettings, DEFAULT_SETTINGS, mergeSettings, parseSettings } from './app-settings.js';
import {
  IPC,
  IPC_EVENTS,
  PROVENANCE_SUFFIX,
  type BackendConfig,
  type BackendResponse,
  type FileOperation,
  type FolderEntry,
  type ProjectInfo,
  type RecoverySnapshot,
  type SidecarInfo,
  isOpenableLink,
} from './ipc-contract.js';
import {
  ProjectPathError,
  ensureLayout,
  readProjectFile,
  readRecoveryFile,
  removeRecoveryFile,
  resolveInProject,
  toProjectRelative,
  writeProjectFile,
  writeRecoveryFile,
} from './project-folder.js';
import {
  baseUrl,
  describeLaunchFailure,
  generateToken,
  pickPort,
  sidecarCommand,
  waitForSidecar,
} from './sidecar-process.js';
import { type ProjectWatcherHandle, watchProject } from './project-watcher.js';
import type { WatcherStatus } from '@nos/media';

/**
 * The Electron main process.
 *
 * Its whole job is the three things a web page cannot do: own a window, own the project folder, and own
 * the sidecar's lifetime. Everything else — the document, the timeline, the compositor, the generator
 * framework — lives in packages that know nothing about Electron, which is what has kept them testable
 * in Node all along.
 *
 * The renderer runs with `contextIsolation: true` and `nodeIntegration: false`. It is treated as the
 * untrusted side even though it runs code from this repository, because the alternative — a renderer
 * with `require` — means any dependency in the UI tree can read the user's home directory.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface Session {
  root: string;
  /** Explicitly `| undefined` rather than optional: it is cleared on exit, which is an assignment. */
  sidecar: ChildProcess | undefined;
  info: SidecarInfo;
  watcher: ProjectWatcherHandle | undefined;
  watcherState: WatcherStatus;
  /** Whether the document has changes not on disk, published by the renderer as it edits. */
  unsaved: boolean;
}

const session: Session = {
  root: '',
  sidecar: undefined,
  info: { baseUrl: '', token: '', available: false, detail: 'no project is open' },
  watcher: undefined,
  watcherState: { watching: false },
  unsaved: false,
};

/**
 * Pushes to every open window.
 *
 * Broadcast rather than addressed, because a change to the folder is true for every window looking
 * at it. Windows that have gone away are skipped rather than treated as an error — closing one
 * during a filesystem burst is ordinary, not exceptional.
 */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

/**
 * Starts watching the newly opened project.
 *
 * A failure is reported to the renderer rather than thrown. The browser then shows an unwatched
 * project with a refresh button, which is honest — where a "watching" indicator over a tree that has
 * stopped tracking reality is the worse outcome the watcher contract exists to avoid.
 */
function startWatching(root: string): void {
  session.watcher?.close();
  session.watcher = watchProject(root, {
    onChanges: (changes) => broadcast(IPC_EVENTS.projectChanged, changes),
    onError: (error) => setWatcherState({ watching: false, error }),
  });
  setWatcherState({ watching: true });
}

/**
 * Records the watcher's state and tells every window.
 *
 * Held as well as broadcast, because the watcher starts while the project is still being opened —
 * before any renderer knows there is a project to subscribe for. A push alone would be sent to
 * nobody, and the browser would report an unwatched folder for the rest of the session.
 */
function setWatcherState(state: WatcherStatus): void {
  session.watcherState = state;
  broadcast(IPC_EVENTS.watcherStatus, state);
}

async function startSidecar(root: string): Promise<SidecarInfo> {
  await stopSidecar();

  const token = generateToken();
  const port = pickPort();
  const python = process.env['NOS_SIDECAR_PYTHON'] ?? defaultPython();
  const { command, args, env } = sidecarCommand({ projectRoot: root, port, token, python });

  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      // The token is in the environment and nowhere else. `stdio: pipe` keeps the child's diagnostics
      // reachable without them landing in a terminal the user never sees.
      env: { ...process.env, ...env },
      // stdin is a pipe this never writes to: closing it is the signal, and the operating system
      // closes it for us however this process ends. `ignore` gave the child nothing to notice.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    return unavailable(describeLaunchFailure('spawn-failed', String(error)));
  }

  let exitDetail: string | undefined;
  child.stderr?.on('data', (chunk: Buffer) => {
    // Kept, not printed: the last lines of stderr are what explain a startup failure, and they are the
    // difference between "it didn't start" and "ffmpeg is missing".
    exitDetail = chunk.toString('utf8').trim().slice(-500);
  });
  child.on('exit', (code) => {
    if (session.sidecar === child) {
      session.sidecar = undefined;
      session.info = unavailable(describeLaunchFailure('exited', exitDetail ?? `code ${code}`));
    }
  });

  session.sidecar = child;

  const ready = await waitForSidecar(port);
  if (!ready) {
    await stopSidecar();
    return unavailable(describeLaunchFailure('timeout', exitDetail));
  }

  return { baseUrl: baseUrl(port), token, available: true };
}

function unavailable(detail: string): SidecarInfo {
  return { baseUrl: '', token: '', available: false, detail };
}

/** The sidecar's own virtualenv when it exists, so a checkout runs without a global install. */
function defaultPython(): string {
  return join(here, '..', '..', '..', 'sidecar', '.venv', 'bin', 'python');
}

async function stopSidecar(): Promise<void> {
  const child = session.sidecar;
  if (child === undefined) return;
  session.sidecar = undefined;
  child.kill('SIGTERM');
}

/**
 * Where the last-opened project is remembered.
 *
 * `userData`, not the renderer. It was `localStorage` on a `file://` origin, which Chromium does not
 * guarantee to persist — observably it survived some restarts on this machine and not others — so an
 * editor whose stated reason for remembering is "you should not have to navigate a folder picker to
 * use it" sent the user to a folder picker at random.
 */
/**
 * Where settings that belong to the installation live.
 *
 * Beside the session file and the shared generator library, and for the same reason: a cap on how much
 * work this machine takes on follows the machine, not the cut, so `project.json` is the wrong place by
 * definition.
 */
function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** The stored settings, or the defaults — a missing or unreadable file is not an error. */
async function readAppSettings(): Promise<AppSettings> {
  try {
    return parseSettings(JSON.parse(await readFile(settingsFile(), 'utf8')));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function sessionFile(): string {
  return join(app.getPath('userData'), 'session.json');
}

/**
 * Where the generator library shared by every project lives.
 *
 * Beside the session file under `userData`, and for the same reason: it belongs to the installation
 * rather than to any project, and it has to survive every project being closed. §5.6 asks for this
 * alongside the project's own `generators/`, and only the project's existed — so every new project
 * started with none at all.
 */
function libraryRoot(): string {
  return join(app.getPath('userData'), 'generators');
}

async function rememberProject(root: string): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(sessionFile(), `${JSON.stringify({ lastProject: root }, null, 2)}\n`, 'utf8');
  } catch {
    // Failing to remember is not a reason to fail to open. The next launch shows the picker, which is
    // the behaviour this replaces rather than something worse.
  }
}

async function lastProject(): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionFile(), 'utf8'));
    const last = (parsed as { lastProject?: unknown }).lastProject;
    return typeof last === 'string' && last !== '' ? last : undefined;
  } catch {
    // No file on a first run, and a corrupt one is the same answer: there is nothing to reopen.
    return undefined;
  }
}

async function openFolder(root: string): Promise<ProjectInfo> {
  await ensureLayout(root);
  session.root = root;
  startWatching(root);

  // Remembered here rather than by the caller, so every path that opens a project — the picker, the
  // restore on launch — records it, and none of them can forget.
  void rememberProject(root);

  /*
    The sidecar starts in the background, and this is the whole point of the change.

    It used to be awaited here, and `waitForSidecar` allows fifteen seconds — so on any machine where
    Python is slow, or ffmpeg is missing, or the dependencies are simply not installed, choosing a
    folder did *nothing visible* for fifteen seconds and then opened. The editor showed "no project
    open" the entire time. Every launch on such a machine looked broken.

    Nothing about opening a project needs it. The document is on disk, and cutting, trimming, undo and
    the whole timeline work without a sidecar; what needs one is a proxy, a waveform and an export,
    and each of those already reports its own absence. The renderer shows the state as a badge and now
    hears about it when it settles.
  */
  // Reported as *starting* rather than as failed: "unavailable" is a verdict, and for the first few
  // seconds there is no verdict yet. The badge says so, and says why when there is a reason.
  session.info = unavailable('the sidecar is starting');
  void startSidecar(root).then((info) => {
    // Discarded if another project was opened while this was starting: the answer describes a root
    // that is no longer the session's, and adopting it would report a sidecar for the wrong folder.
    if (session.root !== root) return;
    session.info = info;
    broadcast(IPC_EVENTS.sidecarStatus, info);
  });

  const document = await readProjectFile(root);
  return { root, name: basename(root), ...(document !== undefined ? { document } : {}) };
}

function registerHandlers(): void {
  ipcMain.handle(IPC.openProject, async (): Promise<ProjectInfo | undefined> => {
    const chosen = await dialog.showOpenDialog({
      title: 'Open project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const root = chosen.filePaths[0];
    if (chosen.canceled || root === undefined) return undefined;
    return openFolder(root);
  });

  ipcMain.handle(IPC.loadProject, async (_event, root: unknown): Promise<ProjectInfo | undefined> => {
    if (typeof root !== 'string' || root === '') return undefined;
    return openFolder(root);
  });

  ipcMain.handle(IPC.saveProject, async (_event, contents: unknown): Promise<void> => {
    requireProject();
    if (typeof contents !== 'string') throw new TypeError('project contents must be a string');
    await writeProjectFile(session.root, contents);
  });

  ipcMain.handle(IPC.saveRecovery, async (_event, contents: unknown): Promise<void> => {
    await writeRecoveryFile(requireProject(), requireString(contents));
  });

  ipcMain.handle(IPC.loadRecovery, async (): Promise<RecoverySnapshot | undefined> => {
    return readRecoveryFile(requireProject());
  });

  ipcMain.handle(IPC.clearRecovery, async (): Promise<void> => {
    await removeRecoveryFile(requireProject());
  });

  ipcMain.handle(IPC.readTextFile, async (_event, path: unknown): Promise<string | undefined> => {
    // Nothing to read before a project is open, which is an answer rather than a fault: the renderer
    // mounts its panels first and several of them ask immediately. Throwing turned an ordinary race
    // into an uncaught rejection in the main process.
    if (session.root === '') return undefined;
    const absolute = resolveInProject(requireProject(), requireString(path));
    try {
      const { readFile } = await import('node:fs/promises');
      return await readFile(absolute, 'utf8');
    } catch {
      return undefined;
    }
  });

  /*
   * The shared library, per §5.6.
   *
   * Under `userData` rather than in a project, because that is what "global" means here: generators a
   * user installs once and has in every project they open afterwards. It is created on first read so
   * a fresh install has somewhere to put things rather than an error to work out.
   *
   * Guarded exactly like the project handlers, against its own root. A library path is still a path a
   * renderer asked for, and `..` reaches the rest of `userData` — the session file included.
   */
  ipcMain.handle(IPC.libraryPath, async (): Promise<string> => libraryRoot());

  ipcMain.handle(IPC.listLibrary, async (_event, path: unknown): Promise<readonly FolderEntry[]> => {
    const root = libraryRoot();
    await mkdir(root, { recursive: true }).catch(() => undefined);

    const requested = path === '' || path === undefined ? '' : requireString(path);
    const target = requested === '' ? root : resolveInProject(root, requested);

    const entries = await readdir(target, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) return [];

    const results: FolderEntry[] = [];
    for (const entry of entries) {
      const absolute = join(target, entry.name);
      const relative = toProjectRelative(root, absolute);
      if (relative === undefined) continue;

      const size = entry.isFile() ? await stat(absolute).catch(() => undefined) : undefined;
      results.push({
        path: relative,
        name: entry.name,
        kind: entry.isDirectory() ? 'folder' : 'file',
        ...(size !== undefined ? { sizeBytes: size.size } : {}),
      });
    }
    return results;
  });

  ipcMain.handle(IPC.readLibraryFile, async (_event, path: unknown): Promise<string | undefined> => {
    const absolute = resolveInProject(libraryRoot(), requireString(path));
    try {
      const { readFile } = await import('node:fs/promises');
      return await readFile(absolute, 'utf8');
    } catch {
      return undefined;
    }
  });

  ipcMain.handle(IPC.writeTextFile, async (_event, path: unknown, contents: unknown): Promise<void> => {
    const absolute = resolveInProject(requireProject(), requireString(path));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, requireString(contents), 'utf8');
  });

  ipcMain.handle(IPC.writeMixdown, async (_event, contents: unknown): Promise<string> => {
    if (!(contents instanceof Uint8Array)) throw new Error('the mixdown must be bytes');

    // A fixed name, deliberately: the mixdown belongs to the export happening now, and accumulating one
    // file per export in a folder the user never opens is how a cache quietly reaches tens of gigabytes.
    const relative = 'cache/mixdown.wav';
    const absolute = resolveInProject(requireProject(), relative);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
    return relative;
  });

  ipcMain.handle(IPC.setUnsaved, (_event, unsaved: unknown): void => {
    session.unsaved = unsaved === true;
  });

  ipcMain.handle(IPC.closeWindow, (): void => {
    // The renderer asked, which it only does once a save it started has landed. The flag lets the
    // window's own handler through rather than asking a second time.
    closing = true;
    BrowserWindow.getAllWindows().forEach((window) => window.close());
  });

  ipcMain.handle(IPC.appSettings, async (): Promise<AppSettings> => readAppSettings());

  ipcMain.handle(IPC.updateAppSettings, async (_event, patch: unknown): Promise<AppSettings> => {
    const next = mergeSettings(await readAppSettings(), patch);
    await mkdir(dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
    return next;
  });

  ipcMain.handle(IPC.chooseFilesToImport, async (): Promise<readonly string[]> => {
    // The dialog only. Where the files should land and what they should be called is decided in the
    // renderer, which can import the tested rule — this process may import *types* from the workspace
    // packages but not values, because it is loaded as source rather than bundled.
    const chosen = await dialog.showOpenDialog({
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
    });
    return chosen.canceled ? [] : chosen.filePaths;
  });

  ipcMain.handle(IPC.copyIntoProject, async (_event, placements: unknown): Promise<readonly string[]> => {
    if (!Array.isArray(placements)) return [];
    const root = requireProject();
    const landed: string[] = [];

    for (const placement of placements) {
      const from = (placement as { from?: unknown }).from;
      const to = (placement as { to?: unknown }).to;
      if (typeof from !== 'string' || typeof to !== 'string') continue;

      // Resolved against the project for every entry, so a destination the renderer got wrong — or
      // was made to get wrong — cannot write outside the folder.
      const destination = resolveInProject(root, to);
      try {
        await mkdir(dirname(destination), { recursive: true });
        // `COPYFILE_EXCL` as a second line of defence: the plan avoided every name it could see, and
        // a race with something else writing the folder must not overwrite material.
        await copyFile(from, destination, constants.COPYFILE_EXCL);
        landed.push(to);
      } catch {
        // One file that cannot be read costs that file. Refusing the whole import because the last
        // of twenty was on an unplugged card would be a worse trade.
      }
    }

    return landed;
  });

  ipcMain.handle(IPC.listFolder, async (_event, path: unknown): Promise<readonly FolderEntry[]> => {
    // Empty, not an error, for the same reason `readTextFile` returns nothing: a folder in a project
    // that is not open has no entries, and the mask cache and the browser both ask on mount.
    if (session.root === '') return [];
    const root = requireProject();
    const target = path === '' || path === undefined ? root : resolveInProject(root, requireString(path));

    // A folder that has never existed has no entries. `readdir` raises `ENOENT`, which crossed the IPC
    // boundary as a rejection and — with a closed stdout — took the main process down with it. The
    // mask cache asks for a key's folder before anything has been written to it, which is every first
    // segmentation of every clip, so this is the common path rather than an edge.
    const entries = await readdir(target, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) return [];

    const results: FolderEntry[] = [];
    for (const entry of entries) {
      const absolute = join(target, entry.name);
      const relative = toProjectRelative(root, absolute);
      // A symlink pointing outside the project resolves outside it, and must not be listed as if it
      // were project content.
      if (relative === undefined) continue;

      if (entry.isDirectory()) {
        results.push({ path: relative, name: entry.name, kind: 'folder' });
      } else if (entry.isFile()) {
        const info = await stat(absolute).catch(() => undefined);
        results.push({
          path: relative,
          name: entry.name,
          kind: 'file',
          ...(info === undefined ? {} : { sizeBytes: info.size }),
        });
      }
    }
    return results;
  });

  ipcMain.handle(IPC.watcherStatus, (): WatcherStatus => session.watcherState);

  ipcMain.handle(IPC.sidecarInfo, (): SidecarInfo => session.info);

  ipcMain.handle(IPC.backendConfig, async (): Promise<BackendConfig> =>
    backendConfig(await readAppSettings()),
  );

  ipcMain.handle(
    IPC.exportFrames,
    async (_event, path: unknown, frames: unknown): Promise<BackendResponse> => {
      // A relative sidecar path, like every other renderer-supplied path: a full URL here would let the
      // renderer post the frame buffer to any host.
      const target = requireBackendPath(path);
      if (!(frames instanceof ArrayBuffer) && !ArrayBuffer.isView(frames)) {
        throw new TypeError('expected frame bytes');
      }
      const body = frames instanceof ArrayBuffer ? frames : (frames as ArrayBufferView).buffer;

      if (!session.info.available) {
        return { ok: false, status: 0, body: 'the media sidecar is not running' };
      }

      try {
        const response = await fetch(`${session.info.baseUrl}${target}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-nos-token': session.info.token },
          body: body as ArrayBuffer,
        });
        return { ok: response.ok, status: response.status, body: await response.text() };
      } catch (error) {
        return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    IPC.backendDownload,
    async (_event, path: unknown, destination: unknown): Promise<BackendResponse> => {
      const target = resolveInProject(requireProject(), requireString(destination));
      const { baseUrl } = backendConfig(await readAppSettings());

      try {
        const response = await fetch(`${baseUrl}${requireBackendPath(path)}`, {
          headers: backendAuthHeaders(),
        });
        if (!response.ok) {
          return { ok: false, status: response.status, body: await response.text() };
        }

        const { mkdir, writeFile, rename } = await import('node:fs/promises');
        await mkdir(dirname(target), { recursive: true });
        // Through a temporary sibling and a rename, for the same reason `project.json` is: the
        // folder watcher is live, and a partially written file would surface in the browser as an
        // asset the user could drag onto a timeline.
        const temporary = `${target}.partial`;
        await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
        await rename(temporary, target);

        return { ok: true, status: response.status, body: '' };
      } catch (error) {
        return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(IPC.backendFetch, async (_event, path: unknown, init: unknown): Promise<BackendResponse> => {
    const options = (init ?? {}) as { method?: string; body?: string; contentType?: string };
    return callBackend(requireBackendPath(path), {
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      headers: {
        ...(options.contentType !== undefined ? { 'content-type': options.contentType } : {}),
        ...backendAuthHeaders(),
      },
    });
  });

  ipcMain.handle(
    IPC.backendUpload,
    async (_event, path: unknown, file: unknown, field: unknown): Promise<BackendResponse> => {
      const absolute = resolveInProject(requireProject(), requireString(file));
      const { readFile } = await import('node:fs/promises');
      const bytes = await readFile(absolute);

      const form = new FormData();
      form.append(
        typeof field === 'string' && field !== '' ? field : 'image',
        new Blob([new Uint8Array(bytes)]),
        basename(absolute),
      );
      // `overwrite` keeps repeated runs from accumulating `file (1).png` copies server-side, which would
      // then no longer match the filename patched into the graph.
      form.append('overwrite', 'true');

      return callBackend(requireBackendPath(path), {
        method: 'POST',
        body: form,
        headers: backendAuthHeaders(),
      });
    },
  );

  ipcMain.handle(IPC.writeProvenance, async (_event, asset: unknown, contents: unknown): Promise<void> => {
    // The suffix is appended here rather than accepted from the renderer, which keeps this a way to
    // annotate a file instead of a way to write one anywhere in the project.
    const target = `${resolveInProject(requireProject(), requireString(asset))}${PROVENANCE_SUFFIX}`;
    const { mkdir, writeFile, rename } = await import('node:fs/promises');
    await mkdir(dirname(target), { recursive: true });
    // Through a sibling and a rename, like every other write here: the folder watcher is live and a
    // half-written record would be read by the browser as a broken one.
    const temporary = `${target}.partial`;
    await writeFile(temporary, requireString(contents), 'utf8');
    await rename(temporary, target);
  });

  ipcMain.handle(IPC.createFolder, async (_event, path: unknown): Promise<FileOperation> => {
    const target = resolveInProject(requireProject(), requireString(path));
    const { mkdir } = await import('node:fs/promises');
    try {
      // Non-recursive on purpose: `recursive` succeeds silently on a folder that already exists, and
      // "New folder" landing on an existing one would look like it worked and change nothing.
      await mkdir(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeFileError(error, requireString(path)) };
    }
  });

  ipcMain.handle(IPC.moveEntry, async (_event, from: unknown, to: unknown): Promise<FileOperation> => {
    const root = requireProject();
    const source = resolveInProject(root, requireString(from));
    const target = resolveInProject(root, requireString(to));
    const { rename, access } = await import('node:fs/promises');

    try {
      // Checked rather than left to `rename`, which overwrites a file at the destination without a
      // word. Losing a take to a name collision is not a risk worth taking for one `access` call.
      await access(target);
      return { ok: false, detail: `${requireString(to)} already exists` };
    } catch {
      // Absent, which is what we want.
    }

    try {
      await rename(source, target);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeFileError(error, requireString(from)) };
    }
  });

  ipcMain.handle(IPC.trashEntry, async (_event, path: unknown): Promise<FileOperation> => {
    const target = resolveInProject(requireProject(), requireString(path));
    try {
      // The OS trash rather than `unlink`: a generated file can be an afternoon of GPU time, and the
      // operating system already provides the undo we would otherwise have to invent.
      await shell.trashItem(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeFileError(error, requireString(path)) };
    }
  });

  ipcMain.handle(IPC.lastProject, async (): Promise<string | undefined> => lastProject());

  ipcMain.handle(IPC.revealInFolder, async (_event, path: unknown): Promise<void> => {
    shell.showItemInFolder(resolveInProject(requireProject(), requireString(path)));
  });

  ipcMain.handle(IPC.openExternal, async (_event, url: unknown): Promise<boolean> => {
    if (!isOpenableLink(requireString(url))) return false;
    await shell.openExternal(requireString(url));
    return true;
  });
}

/**
 * Where the generator backend lives.
 *
 * Environment-driven rather than hard-coded, because the endpoint genuinely varies — a local ComfyUI on
 * 8188, an instance behind a reverse proxy with basic auth, a machine on the LAN. The credentials are
 * read here and never handed to the renderer.
 */
/**
 * A filesystem failure as a sentence.
 *
 * The `errno` codes are the ones a user can actually cause from a file browser, and each has a
 * different answer: a name already taken means pick another, a permission problem means the folder
 * is not yours, and a non-empty directory means look inside first.
 */
function describeFileError(error: unknown, path: string): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'EEXIST':
      return `${path} already exists`;
    case 'ENOENT':
      return `${path} is no longer there`;
    case 'EACCES':
    case 'EPERM':
      return `no permission to change ${path}`;
    case 'ENOTEMPTY':
      return `${path} is not empty`;
    case 'EXDEV':
      // Only reachable when a project folder spans mount points, which is legal and surprising.
      return `${path} cannot be moved across devices`;
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Where the backend is.
 *
 * The stored setting first, then the environment, then the local default. §3 says the endpoints are
 * configurable, and until the setting existed that meant "configurable by whoever launches the
 * process" — not by the person using it.
 *
 * The environment still wins over the built-in default, so a scripted or containerised launch that
 * sets `NOS_COMFYUI_URL` keeps working; the user's own choice wins over both, because it is the more
 * deliberate of the two.
 */
function backendConfig(stored: AppSettings): BackendConfig {
  const baseUrl = (
    stored.backendUrl !== '' ? stored.backendUrl : (process.env['NOS_COMFYUI_URL'] ?? 'http://127.0.0.1:8188')
  ).replace(/\/+$/, '');
  return { baseUrl, authenticated: process.env['NOS_COMFYUI_USER'] !== undefined };
}

function backendAuthHeaders(): Record<string, string> {
  const user = process.env['NOS_COMFYUI_USER'];
  const password = process.env['NOS_COMFYUI_PASSWORD'];
  if (user === undefined || password === undefined) return {};
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

/**
 * Calls the backend from the main process.
 *
 * This exists because ComfyUI sends no CORS headers: a renderer loaded from `file://` cannot reach it at
 * all, and the failure presents as "the server is unreachable" while the server is running perfectly.
 * Proxying also keeps basic-auth credentials out of the page.
 */
async function callBackend(path: string, init: RequestInit): Promise<BackendResponse> {
  // Read per call rather than cached: the address can change while the application is running, and a
  // cached one would keep every later request pointed at the machine the user just moved away from.
  const { baseUrl } = backendConfig(await readAppSettings());
  try {
    const response = await fetch(`${baseUrl}${path}`, init);
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

/** Only a path, never a URL: a full URL here would make the renderer able to name any host. */
function requireBackendPath(value: unknown): string {
  const path = requireString(value);
  if (!path.startsWith('/')) throw new TypeError('a backend path must start with "/"');
  if (path.startsWith('//')) throw new TypeError('a backend path must not be protocol-relative');
  return path;
}

function requireProject(): string {
  if (session.root === '') throw new Error('no project is open');
  return session.root;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('expected a string path');
  return value;
}

/**
 * Set once the user has answered the unsaved-changes prompt, so the second `close` goes through.
 *
 * Module-level rather than per-window because there is one window; a multi-window build would key it
 * by window, and this is the line that would have to change.
 */
let closing = false;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
    // The preset's own dark background, `oklch(0.147 0.004 49.3)`, written as a hex literal because
    // the main process runs unbundled and cannot read a stylesheet. It is here only to colour the
    // frame between the window opening and the renderer painting; the theme itself is next-themes'.
    // If the palette changes, this is the one place outside `globals.css` that has to follow.
    backgroundColor: '#0c0a09',
    // Shown once painted: an empty white frame while the bundle loads reads as a broken application.
    show: false,
    webPreferences: {
      // `.mjs` rather than `.js`: Electron only treats a preload script as an ES module when the
      // extension says so, and this package is ESM throughout. The build copies it into place.
      preload: join(here, '..', 'preload', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  /*
   * Shown once painted. Off to one side and unfocused when something is driving it.
   *
   * The harnesses launch a real shell and talk to it over the debugging port; three per `smokecheck`
   * run, several runs an hour, is a window repeatedly taking the screen from whoever is using the
   * machine.
   *
   * Not hidden, though — that was the first attempt and it fails for a reason worth keeping: a window
   * that is never mapped never lays out, so every element reads as invisible and the harness times out
   * clicking things that are plainly there. The window has to be real for the checks to mean anything.
   *
   * So: `showInactive` rather than `show`, which never takes focus, and moved off the visible desktop
   * so it covers nothing. The renderer paints and answers exactly as it does for a user — this is the
   * same application with its frame somewhere else, not a different mode that could pass for reasons a
   * user would never have.
   */
  window.once('ready-to-show', () => {
    if (process.env['NOS_HEADLESS'] === '1') {
      // Far enough that no plausible monitor arrangement reaches it. Set before showing, so the frame
      // never appears at the origin first.
      window.setPosition(-10_000, -10_000);
      window.showInactive();
      return;
    }
    window.show();
  });

  /*
   * Closing with unsaved work asks first.
   *
   * The autosave would recover it on the next launch, so nothing is lost outright — but up to thirty
   * seconds of editing sits between two ticks, and a user who meant to keep their work should not have
   * to discover a recovery prompt to get it back. Being asked is also how they find out there *was*
   * unsaved work, which a window that simply vanishes never tells them.
   *
   * The renderer publishes whether it is dirty rather than being asked at close time: a question at
   * that moment races the window's own teardown, and a stale answer here means either a lost edit or a
   * prompt nobody can explain.
   */
  window.on('close', (event) => {
    if (!session.unsaved || closing) return;
    event.preventDefault();

    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: 'This project has changes that have not been saved.',
      detail: 'Saving keeps them in project.json. Closing without saving leaves them recoverable.',
    });

    if (choice === 2) return;

    if (choice === 0) {
      // Asked of the renderer, which owns the document; it closes the window when the write lands, so
      // a slow save cannot be overtaken by the close it was meant to precede.
      window.webContents.send(IPC_EVENTS.saveBeforeClose);
      return;
    }

    closing = true;
    window.close();
  });

  const devServer = process.env['NOS_DEV_SERVER'];
  if (devServer !== undefined && devServer !== '') {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(here, '..', 'renderer', 'index.html'));
  }
}

/**
 * A closed stdout is not a reason to stop editing.
 *
 * When the shell is launched from a terminal that goes away — a script that exits, a pipe that is not
 * read — the next write to `stdout` or `stderr` raises `EPIPE`. Node reports that as an *uncaught
 * exception*, and Electron's default handler for one is a modal "A JavaScript error occurred in the
 * main process" over the editor. So a diagnostic nobody was reading took the application down.
 *
 * Narrow on purpose: only `EPIPE`, only on the two streams. Everything else still crashes loudly,
 * because a main-process fault that is genuinely a fault must not be swallowed.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // The sidecar holds an ffmpeg pipe and possibly a model in VRAM; leaving it running past the last
  // window would keep both alive with nothing to consume them.
  session.watcher?.close();
  session.watcher = undefined;
  session.watcherState = { watching: false };
  void stopSidecar();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  session.watcher?.close();
  session.watcher = undefined;
  void stopSidecar();
});

export { ProjectPathError };
