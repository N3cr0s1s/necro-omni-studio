import { type ChildProcess, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import {
  IPC,
  type BackendConfig,
  type BackendResponse,
  type FolderEntry,
  type ProjectInfo,
  type RecoverySnapshot,
  type SidecarInfo,
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
}

const session: Session = {
  root: '',
  sidecar: undefined,
  info: { baseUrl: '', token: '', available: false, detail: 'no project is open' },
};

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
      stdio: ['ignore', 'pipe', 'pipe'],
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

async function openFolder(root: string): Promise<ProjectInfo> {
  await ensureLayout(root);
  session.root = root;
  session.info = await startSidecar(root);

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
    const absolute = resolveInProject(requireProject(), requireString(path));
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

  ipcMain.handle(IPC.listFolder, async (_event, path: unknown): Promise<readonly FolderEntry[]> => {
    const root = requireProject();
    const target = path === '' || path === undefined ? root : resolveInProject(root, requireString(path));

    const entries = await readdir(target, { withFileTypes: true });
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

  ipcMain.handle(IPC.sidecarInfo, (): SidecarInfo => session.info);

  ipcMain.handle(IPC.backendConfig, (): BackendConfig => backendConfig());

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

  ipcMain.handle(IPC.revealInFolder, async (_event, path: unknown): Promise<void> => {
    shell.showItemInFolder(resolveInProject(requireProject(), requireString(path)));
  });
}

/**
 * Where the generator backend lives.
 *
 * Environment-driven rather than hard-coded, because the endpoint genuinely varies — a local ComfyUI on
 * 8188, an instance behind a reverse proxy with basic auth, a machine on the LAN. The credentials are
 * read here and never handed to the renderer.
 */
function backendConfig(): BackendConfig {
  const baseUrl = (process.env['NOS_COMFYUI_URL'] ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');
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
  const { baseUrl } = backendConfig();
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

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
    backgroundColor: '#0d0e11',
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

  window.once('ready-to-show', () => window.show());

  const devServer = process.env['NOS_DEV_SERVER'];
  if (devServer !== undefined && devServer !== '') {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(here, '..', 'renderer', 'index.html'));
  }
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
  void stopSidecar();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void stopSidecar();
});

export { ProjectPathError };
