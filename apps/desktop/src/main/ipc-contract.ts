/**
 * The main/renderer contract.
 *
 * One module, imported by both sides, so the channel names and payload shapes cannot drift apart. The
 * renderer runs with `contextIsolation` and `nodeIntegration: false` — it has no filesystem, no process
 * and no network privileges beyond what a web page has — so **this list is the entire trust boundary**.
 * Every capability the renderer has is a channel here, which is exactly the property that makes the
 * boundary reviewable.
 *
 * Two rules the handlers hold to:
 *
 * - Every path in a payload is **project-relative**. An absolute path crossing this boundary would let a
 *   compromised renderer name any file on the machine.
 * - Every handler validates rather than trusts. The renderer is the untrusted side of this boundary,
 *   even though today it runs code from the same repository.
 */

export const IPC = {
  /** Opens a folder picker and returns the chosen project. */
  openProject: 'project:open',
  /** Re-opens a known folder without a dialog, for the recent list. */
  loadProject: 'project:load',
  /** Writes `project.json`. */
  saveProject: 'project:save',
  /** Writes the crash-recovery sibling, atomically. */
  saveRecovery: 'project:save-recovery',
  /** Reads the recovery sibling and the timestamps needed to decide whether it is stale. */
  loadRecovery: 'project:load-recovery',
  /** Deletes the recovery sibling after a clean save or an explicit discard. */
  clearRecovery: 'project:clear-recovery',
  /** Reads a project-relative text file, e.g. a manifest or a note. */
  readTextFile: 'project:read-text',
  /** Records what generated an output, beside the output. */
  writeProvenance: 'project:write-provenance',
  /** Creates a folder inside the project. */
  createFolder: 'project:create-folder',
  /** Renames or moves an entry inside the project. */
  moveEntry: 'project:move',
  /** Sends an entry to the operating system's trash. */
  trashEntry: 'project:trash',
  /** Writes a project-relative text file. */
  writeTextFile: 'project:write-text',
  writeMixdown: 'export:write-mixdown',
  setUnsaved: 'window:set-unsaved',
  closeWindow: 'window:close',
  appSettings: 'app:settings',
  updateAppSettings: 'app:update-settings',
  chooseFilesToImport: 'project:choose-import',
  chooseExportPath: 'project:choose-export-path',
  copyIntoProject: 'project:copy-in',
  /** Lists a project subtree. */
  listFolder: 'project:list',
  /** The watcher's current state, for a renderer that subscribed after it started. */
  watcherStatus: 'project:watcher-state',
  /** Where the sidecar is listening, and the token to reach it. */
  sidecarInfo: 'sidecar:info',
  /** The project this application last had open, remembered across launches. */
  lastProject: 'project:last',
  recentProjects: 'project:recent',
  /** The generator library shared by every project, per §5.6. */
  listLibrary: 'library:list',
  readLibraryFile: 'library:read',
  libraryPath: 'library:path',
  /** Reveals a project-relative path in the OS file manager. */
  revealInFolder: 'shell:reveal',
  /** Opens a web link in the user's browser, never in this window. */
  openExternal: 'shell:open-external',
  /** Performs an HTTP call against the generator backend, from the main process. */
  backendFetch: 'backend:fetch',
  /** Uploads a project file to the backend as multipart form data. */
  backendUpload: 'backend:upload',
  /** Downloads a backend file into the project folder. */
  backendDownload: 'backend:download',
  /** Where the generator backend lives. */
  backendConfig: 'backend:config',
  /** Streams encoded frame bytes to the sidecar from the main process. */
  exportFrames: 'export:frames',
} as const;

/**
 * Channels the main process pushes on, without being asked.
 *
 * Kept separate from `IPC` because they are a different *direction* across the boundary and carry a
 * different risk. An invoke channel is a capability the renderer may use; a push channel is data the
 * renderer must be prepared to receive at any moment. The preload subscribes to exactly these two
 * and exposes typed callbacks — never `ipcRenderer.on`, which would let a renderer bug listen to
 * every channel the main process ever sends on.
 */
export const IPC_EVENTS = {
  /**
   * The user chose Save when closing with unsaved work.
   *
   * The renderer writes and then closes the window itself, so a slow save cannot be overtaken by the
   * close it was meant to precede.
   */
  saveBeforeClose: 'window:save-before-close',
  /** A batch of project-relative filesystem changes. */
  projectChanged: 'project:changed',
  /** The watcher started, stopped, or failed. */
  watcherStatus: 'project:watcher-status',
  /**
   * The sidecar became available, or failed to.
   *
   * An event rather than only a request, because starting it takes seconds and opening a project must
   * not wait for it: the project is usable — cut, trim, undo — long before anything needs a proxy.
   */
  sidecarStatus: 'sidecar:status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

import type { FileChange, WatcherStatus } from '@nos/media';
import type { AppSettings } from './app-settings.js';

/**
 * Suffix appended to name a file's provenance record.
 *
 * Mirrors `PROVENANCE_SUFFIX` in `@nos/generators` rather than importing it: the main process runs
 * unbundled, so a *value* import from a workspace package would have to resolve against built
 * output. The same reasoning already governs the recovery filename in `project-folder.ts` and the
 * debounce in `project-watcher.ts` — both are part of the on-disk layout, described on both sides.
 * `ipc-contract.test.ts` asserts the two stay equal.
 */
export const PROVENANCE_SUFFIX = '.nos.json';

export interface ProjectInfo {
  /** Absolute, and used only for display and for the recent list. */
  readonly root: string;
  readonly name: string;
  /** Contents of `project.json`, or `undefined` for a folder that has none yet. */
  readonly document?: string;
}

/**
 * One entry in the reopen list.
 *
 * `available` rather than filtering: a project whose folder has been moved is reported and shown
 * unavailable, because a row vanishing on its own is indistinguishable from the application having
 * forgotten it.
 */
export interface RecentProject {
  readonly root: string;
  /** The folder's name, which is what a project is called. */
  readonly name: string;
  readonly available: boolean;
}

/**
 * What startup found beside `project.json`.
 *
 * The timestamps come with the contents rather than being fetched separately, because the decision
 * they feed — is this recovery file newer than the saved project? — is only correct if both were read
 * from the same moment. Two round trips could straddle a save and offer the user older work.
 */
export interface RecoverySnapshot {
  readonly contents: string;
  /** Epoch milliseconds the recovery file was last written. */
  readonly modifiedAt: number;
  /** Epoch milliseconds `project.json` was last written, absent when there is none. */
  readonly projectModifiedAt?: number;
}

/** The result of a file operation: what happened, and in a sentence if it did not work. */
export interface FileOperation {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface SidecarInfo {
  readonly baseUrl: string;
  readonly token: string;
  /** False when the sidecar failed to start; `detail` says why, and the UI greys what needs it. */
  readonly available: boolean;
  readonly detail?: string;
}

/**
 * A backend call's result.
 *
 * The body comes back as text rather than parsed: the caller already knows which endpoints return JSON,
 * and a parse in the bridge would turn a ComfyUI error page into an opaque failure.
 */
export interface BackendResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

export interface BackendConfig {
  /** Origin, no trailing slash. */
  readonly baseUrl: string;
  /** True when basic auth is configured, so the UI can say so. The credentials never cross this line. */
  readonly authenticated: boolean;
}

export interface FolderEntry {
  /** Project-relative, forward slashes on every platform. */
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'folder';
  readonly sizeBytes?: number;
}

/**
 * What `window.nos` exposes.
 *
 * Deliberately a small, explicit surface rather than a generic `invoke(channel, payload)`. A generic
 * bridge re-opens the whole boundary the moment a renderer bug lets an attacker choose the channel
 * name — which is the exact failure this design exists to prevent.
 */
export interface DesktopBridge {
  openProject(): Promise<ProjectInfo | undefined>;
  loadProject(root: string): Promise<ProjectInfo | undefined>;
  saveProject(contents: string): Promise<void>;
  saveRecovery(contents: string): Promise<void>;
  loadRecovery(): Promise<RecoverySnapshot | undefined>;
  clearRecovery(): Promise<void>;
  readTextFile(path: string): Promise<string | undefined>;
  /**
   * Writes a generated file's provenance record beside it.
   *
   * The *asset* is named, not the record: the main process appends the suffix itself, so this is a
   * capability to annotate a file rather than a general licence to write anywhere in the project.
   * Named methods over a generic write is the rule the whole bridge follows.
   */
  writeProvenance(asset: string, contents: string): Promise<void>;

  /**
   * Organising the project folder from inside the application.
   *
   * A project *is* a folder, and until these existed that was true right up to the point where you
   * wanted to tidy it — then you had to leave. All three resolve inside the project and refuse
   * anything outside it, so the renderer cannot name a path on the rest of the disk.
   *
   * Each answers with a problem rather than throwing: a name already taken is an ordinary thing to
   * do, and it deserves a sentence in the browser rather than an unhandled rejection.
   */
  createFolder(path: string): Promise<FileOperation>;
  moveEntry(from: string, to: string): Promise<FileOperation>;
  /**
   * To the trash, never unlinked.
   *
   * A generated file can represent an afternoon of GPU time, and the operating system already
   * provides the undo. An application that deletes outright is one you cannot use decisively.
   */
  trashEntry(path: string): Promise<FileOperation>;
  writeTextFile(path: string, contents: string): Promise<void>;
  /**
   * Writes the rendered audio mix into the project's cache, returning its project-relative path.
   *
   * A named method rather than a general binary write, which is the rule this whole bridge follows: a
   * renderer that can put arbitrary bytes anywhere in the project is a different security posture from
   * one that can hand over a mixdown. It lands in `cache/` because it is derived, disposable and
   * regenerated on the next export — exactly what that folder is documented to hold.
   */
  writeMixdown(contents: Uint8Array): Promise<string>;
  /**
   * Asks the user which files to bring in. Empty when they cancelled, which is not a failure.
   *
   * Split from the copying because only the dialog needs privilege: *where* the files land and what
   * they are called is a rule with tests, and it lives in the renderer where that package can be
   * imported. The main process may import types from the workspace but not values.
   */
  /**
   * Publishes whether the document has changes that are not on disk.
   *
   * Pushed rather than asked for at close time: a question then races the window's own teardown, and a
   * stale answer means either a lost edit or a prompt nobody can explain.
   */
  setUnsaved(unsaved: boolean): Promise<void>;
  /** Closes the window, for the renderer to call once a save asked for at close time has landed. */
  closeWindow(): Promise<void>;
  /** Runs when the user chose Save while closing. Returns a function that stops listening. */
  onSaveBeforeClose(listener: () => void): () => void;
  /**
   * Where a dropped file is on disk, or `''` for a drag that carries no real file.
   *
   * Synchronous and not a channel: it names a file the page already holds. Electron removed
   * `File.path` so that naming one is a privilege the preload grants rather than a property every
   * script can read.
   */
  pathForFile(file: File): string;
  /** Settings that belong to the installation rather than to a project, per §5.8's global override. */
  appSettings(): Promise<AppSettings>;
  /** Applies a change and answers with what was actually stored, validated. */
  updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  chooseFilesToImport(): Promise<readonly string[]>;
  /**
   * Asks where to write an export, and answers with a **project-relative** path.
   *
   * Project-relative because that is what `ExportSettings.outputPath` is and what the sidecar resolves;
   * a destination outside the project is not expressible and is refused rather than silently rewritten.
   * `undefined` means the dialog was cancelled and the **empty string** means a destination outside the
   * project. Two different things, kept apart: a cancel needs nothing said, and a choice outside the
   * folder needs a reason. A picker that quietly moved the file somewhere else would be worse than one
   * that says no.
   */
  chooseExportPath(suggested: string): Promise<string | undefined>;
  /**
   * Copies chosen files to project-relative destinations, returning the ones that landed.
   *
   * Copies rather than references: §4 promises that zipping the folder moves the whole project, and a
   * link to somewhere else on the machine breaks that invisibly — the cut plays until it is opened
   * somewhere else. Never overwrites; a destination that already exists is skipped.
   */
  copyIntoProject(
    placements: readonly { readonly from: string; readonly to: string }[],
  ): Promise<readonly string[]>;
  listFolder(path: string): Promise<readonly FolderEntry[]>;

  /**
   * The generator library shared by every project.
   *
   * §5.6 asks for the project's `generators/` folder **and a global library**, and only the first
   * existed — so every new project started with no generators at all and the manifests had to be
   * copied into each one by hand. This is the other half: a folder outside any project, read on
   * startup like the project's, holding the generators a user installs once.
   *
   * Its own three methods rather than a root the existing ones could take, because the guard that
   * keeps `listFolder` inside the open project is the reason it is safe — and a parameter that could
   * switch it off would be that guard's undoing.
   */
  listLibrary(path: string): Promise<readonly FolderEntry[]>;
  readLibraryFile(path: string): Promise<string | undefined>;
  /** Where it is, so the panel can tell a user where to put things. */
  libraryPath(): Promise<string>;

  /**
   * Subscribes to project folder changes. Returns an unsubscribe function.
   *
   * A callback rather than a polled query, because the events the browser must react to — a
   * generator finishing, a file dropped in from outside — arrive on the filesystem's schedule and
   * not on one the renderer could guess.
   */
  onProjectChanged(listener: (changes: readonly FileChange[]) => void): () => void;
  onWatcherStatus(listener: (status: WatcherStatus) => void): () => void;
  /** Reports the sidecar settling, which happens after a project has already opened. */
  onSidecarStatus(listener: (info: SidecarInfo) => void): () => void;
  /**
   * The watcher's state right now.
   *
   * Asked for on subscribe rather than inferred from having received a push. The watcher starts
   * while the project is being opened — before the renderer knows there is a project to subscribe
   * for — so a renderer that only listened would sit on `not watching` over a folder that is in fact
   * being watched, which is the same class of lie as the reverse.
   */
  watcherStatus(): Promise<WatcherStatus>;
  sidecarInfo(): Promise<SidecarInfo>;
  /**
   * The folder this application last had open, or `undefined` on a first run.
   *
   * Remembered by the *main* process rather than by the renderer. It was `localStorage` on a `file://`
   * origin, which Chromium does not guarantee to persist — observably, it survived some restarts here
   * and not others — so an editor whose whole point is that it reopens what you were working on
   * forgot it at random and sent the user back to a folder picker.
   *
   * The path is returned unverified: whether the folder still exists is answered by trying to open it,
   * which is the same answer the picker gives, in one place.
   */
  lastProject(): Promise<string | undefined>;
  /** Projects opened before, newest first, each saying whether its folder is still there. */
  recentProjects(): Promise<readonly RecentProject[]>;
  revealInFolder(path: string): Promise<void>;
  /**
   * Opens a link in the user's browser.
   *
   * Resolves to `false` for anything the main process refuses. The URL comes from a note in the
   * project folder — a file that arrived from a client, a download or a generator — so it is
   * untrusted input, and the *scheme* is the whole of the danger: `file:` would open a local path
   * through the shell, and on Windows several schemes are handler-invocable with arguments.
   */
  openExternal(url: string): Promise<boolean>;

  /**
   * Calls the generator backend through the main process.
   *
   * Proxied rather than fetched directly, for two reasons that are both load-bearing. ComfyUI sends no
   * CORS headers, so a renderer running from `file://` cannot reach it at all — the failure presents as
   * "unreachable" even with the server running happily. And credentials for a backend behind basic auth
   * stay in the main process instead of being handed to a page.
   */
  backendFetch(
    path: string,
    init?: { method?: string; body?: string; contentType?: string },
  ): Promise<BackendResponse>;
  /** Uploads a project file to the backend. The bytes never pass through the renderer. */
  backendUpload(path: string, file: string, field?: string): Promise<BackendResponse>;
  backendConfig(): Promise<BackendConfig>;
  /**
   * Downloads a file from the generator backend into the project folder.
   *
   * The one thing missing that made generated output unreachable: the backend reported *where the
   * file would be* in the project and nothing ever fetched it, so a finished generation existed only
   * inside ComfyUI. Bytes cross the boundary in the main process, which is also the only side
   * allowed to name a path on disk.
   */
  backendDownload(path: string, destination: string): Promise<BackendResponse>;

  /**
   * Sends raw frames to the encoder, from the main process.
   *
   * Not a `fetch` in the renderer, and the reason is measured rather than assumed: a 16 MB body posted
   * from a page took roughly 1.3 s, while the same body from `curl` took 0.02 s. Chromium copies a large
   * request body across its network-service boundary; Node does not. Routing the bytes through here took
   * the export's dominant cost — 78% of its wall clock — down to noise.
   */
  exportFrames(path: string, frames: ArrayBuffer): Promise<BackendResponse>;
}

declare global {
  var nos: DesktopBridge | undefined;
}

/**
 * Whether a link from a note may be handed to the shell.
 *
 * An allow-list of two schemes, checked in the *main* process where the decision cannot be bypassed by
 * anything the renderer runs. The URL comes from a markdown file in the project folder, which arrives
 * from a client, a download or a generator — so the scheme is the whole of the danger. `file:` would
 * open a local path through the shell; on Windows a registered handler can be invoked with arguments;
 * and `javascript:` is refused here as well as by the renderer never using an `href`.
 *
 * Exported so the rule is tested rather than trusted.
 */
export function isOpenableLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    // Not a URL at all — a relative path, or prose that looked like one. Nothing to open.
    return false;
  }
}
