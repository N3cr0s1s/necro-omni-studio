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
  /** Writes a project-relative text file. */
  writeTextFile: 'project:write-text',
  /** Lists a project subtree. */
  listFolder: 'project:list',
  /** Where the sidecar is listening, and the token to reach it. */
  sidecarInfo: 'sidecar:info',
  /** Reveals a project-relative path in the OS file manager. */
  revealInFolder: 'shell:reveal',
  /** Performs an HTTP call against the generator backend, from the main process. */
  backendFetch: 'backend:fetch',
  /** Uploads a project file to the backend as multipart form data. */
  backendUpload: 'backend:upload',
  /** Where the generator backend lives. */
  backendConfig: 'backend:config',
  /** Streams encoded frame bytes to the sidecar from the main process. */
  exportFrames: 'export:frames',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

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
  writeTextFile(path: string, contents: string): Promise<void>;
  listFolder(path: string): Promise<readonly FolderEntry[]>;
  sidecarInfo(): Promise<SidecarInfo>;
  revealInFolder(path: string): Promise<void>;

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
