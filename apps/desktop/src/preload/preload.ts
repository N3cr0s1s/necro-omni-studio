import { contextBridge, ipcRenderer } from 'electron';
import { IPC, IPC_EVENTS, type DesktopBridge } from '../main/ipc-contract.js';

/**
 * The preload bridge.
 *
 * The only code running with both Node and page privileges, so it is deliberately the smallest file in
 * the application: it forwards a fixed set of named calls and exposes nothing else. No `ipcRenderer`, no
 * `require`, no generic `invoke` — a renderer that could choose the channel name would have the whole
 * main process's surface, which defeats the isolation entirely.
 *
 * Every method here corresponds to one handler in `main.ts`, and the shapes come from the shared
 * contract so the two cannot drift.
 */

/**
 * Wraps one push channel as a typed subscription.
 *
 * The `event` argument is dropped deliberately: it carries a `sender` the renderer has no business
 * holding, and forwarding the payload alone keeps the page's view of IPC to plain data.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

const bridge: DesktopBridge = {
  openProject: () => ipcRenderer.invoke(IPC.openProject),
  loadProject: (root) => ipcRenderer.invoke(IPC.loadProject, root),
  saveProject: (contents) => ipcRenderer.invoke(IPC.saveProject, contents),
  saveRecovery: (contents) => ipcRenderer.invoke(IPC.saveRecovery, contents),
  loadRecovery: () => ipcRenderer.invoke(IPC.loadRecovery),
  clearRecovery: () => ipcRenderer.invoke(IPC.clearRecovery),
  readTextFile: (path) => ipcRenderer.invoke(IPC.readTextFile, path),
  writeTextFile: (path, contents) => ipcRenderer.invoke(IPC.writeTextFile, path, contents),
  listFolder: (path) => ipcRenderer.invoke(IPC.listFolder, path),
  // Each push channel gets its own named subscription. Exposing `ipcRenderer.on` instead would let
  // any renderer bug listen to every channel the main process ever sends on, which is the same
  // mistake as a generic `invoke` in the other direction.
  watcherStatus: () => ipcRenderer.invoke(IPC.watcherStatus),
  onProjectChanged: (listener) => subscribe(IPC_EVENTS.projectChanged, listener),
  onWatcherStatus: (listener) => subscribe(IPC_EVENTS.watcherStatus, listener),
  onSidecarStatus: (listener) => subscribe(IPC_EVENTS.sidecarStatus, listener),
  sidecarInfo: () => ipcRenderer.invoke(IPC.sidecarInfo),
  lastProject: () => ipcRenderer.invoke(IPC.lastProject),
  revealInFolder: (path) => ipcRenderer.invoke(IPC.revealInFolder, path),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  backendFetch: (path, init) => ipcRenderer.invoke(IPC.backendFetch, path, init),
  backendUpload: (path, file, field) => ipcRenderer.invoke(IPC.backendUpload, path, file, field),
  writeProvenance: (asset, contents) => ipcRenderer.invoke(IPC.writeProvenance, asset, contents),
  createFolder: (path) => ipcRenderer.invoke(IPC.createFolder, path),
  moveEntry: (from, to) => ipcRenderer.invoke(IPC.moveEntry, from, to),
  trashEntry: (path) => ipcRenderer.invoke(IPC.trashEntry, path),
  backendConfig: () => ipcRenderer.invoke(IPC.backendConfig),
  backendDownload: (path, destination) => ipcRenderer.invoke(IPC.backendDownload, path, destination),
  exportFrames: (path, frames) => ipcRenderer.invoke(IPC.exportFrames, path, frames),
};

contextBridge.exposeInMainWorld('nos', bridge);
