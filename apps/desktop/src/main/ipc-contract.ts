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
  /** Lists a project subtree. */
  listFolder: 'project:list',
  /** The watcher's current state, for a renderer that subscribed after it started. */
  watcherStatus: 'project:watcher-state',
  /** Where the sidecar is listening, and the token to reach it. */
  sidecarInfo: 'sidecar:info',
  /** The project this application last had open, remembered across launches. */
  lastProject: 'project:last',
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
  listFolder(path: string): Promise<readonly FolderEntry[]>;

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
