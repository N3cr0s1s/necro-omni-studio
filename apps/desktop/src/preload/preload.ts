import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopBridge } from '../main/ipc-contract.js';

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

const bridge: DesktopBridge = {
  openProject: () => ipcRenderer.invoke(IPC.openProject),
  loadProject: (root) => ipcRenderer.invoke(IPC.loadProject, root),
  saveProject: (contents) => ipcRenderer.invoke(IPC.saveProject, contents),
  readTextFile: (path) => ipcRenderer.invoke(IPC.readTextFile, path),
  writeTextFile: (path, contents) => ipcRenderer.invoke(IPC.writeTextFile, path, contents),
  listFolder: (path) => ipcRenderer.invoke(IPC.listFolder, path),
  sidecarInfo: () => ipcRenderer.invoke(IPC.sidecarInfo),
  revealInFolder: (path) => ipcRenderer.invoke(IPC.revealInFolder, path),
  backendFetch: (path, init) => ipcRenderer.invoke(IPC.backendFetch, path, init),
  backendUpload: (path, file, field) => ipcRenderer.invoke(IPC.backendUpload, path, file, field),
  backendConfig: () => ipcRenderer.invoke(IPC.backendConfig),
  exportFrames: (path, frames) => ipcRenderer.invoke(IPC.exportFrames, path, frames),
};

contextBridge.exposeInMainWorld('nos', bridge);
