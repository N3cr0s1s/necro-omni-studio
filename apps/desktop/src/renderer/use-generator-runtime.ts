import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PresetId, type JobGroupId } from '@nos/core';
import {
  type BackendCapabilities,
  type GeneratorBackend,
  type GeneratorManifest,
  type JobTarget,
  type QueueSnapshot,
  type GpuSemaphore,
  createGpuSemaphore,
  createJobQueue,
  createMockBackend,
} from '@nos/generators';
import { createComfyUiBackend, patchGraph } from '@nos/backend-comfyui';
import type { DesktopBridge } from '../main/ipc-contract.js';
import { socketMessages } from './socket-messages.js';
import { bridge } from './bridge.js';

/**
 * The generator runtime.
 *
 * Owns the backend, the GPU semaphore and the job queue for this window, and reports which backend is
 * actually in use. That last part is not cosmetic: the mock backend produces placeholder files, and a
 * user who thinks ComfyUI is running while it is not would wonder why every result looks the same.
 *
 * The fallback is deliberate rather than a failure. The spec separates M9 from M10 so the framework is
 * usable and demonstrable without a GPU, and the mock backend is a shipped artifact — so an unreachable
 * ComfyUI degrades to a working, clearly-labelled offline mode instead of a dead panel.
 */

export type BackendMode = 'comfyui' | 'mock';

export interface GeneratorRuntime {
  readonly mode: BackendMode;
  readonly detail: string;
  /** Why the last run could not start. Cleared by the next successful one. */
  readonly error: string | undefined;
  readonly capabilities: BackendCapabilities | undefined;
  readonly snapshot: QueueSnapshot;
  /**
   * The window's GPU semaphore.
   *
   * Exposed because the spec serializes **three** consumers on one semaphore — the generator backend,
   * the SAM 2 worker and the LLMs built into generator graphs — and only the job queue could reach it
   * while it lived inside the queue's options. Segmentation and export therefore ran straight at a card
   * a generation was already filling, which is the OOM this rule exists to prevent.
   */
  readonly gpu: GpuSemaphore;
  run(request: {
    readonly manifest: GeneratorManifest;
    readonly preset?: PresetId;
    readonly params: Readonly<Record<string, string | number | boolean>>;
    readonly target: JobTarget;
    readonly variantCount?: number;
    readonly lockedSeed?: number;
  }): JobGroupId | undefined;
  cancelGroup(group: JobGroupId): void;
  /** Forgets a group, so discarding a finished one actually removes it from the picker. */
  dismissGroup(group: JobGroupId): void;
}

const EMPTY_SNAPSHOT: QueueSnapshot = { groups: [], runs: [], activeCount: 0 };

export interface RuntimeOptions {
  /** ComfyUI origin. Defaults to the local instance the spec assumes is running. */
  readonly endpoint?: string;
  /**
   * Graphs by filename, so a submit can be patched.
   *
   * A ref rather than a value: the library loads *after* the runtime, because the registry needs the
   * node classes this runtime probes. Threading it as a ref breaks that cycle without rebuilding the
   * queue — and therefore losing its in-flight jobs — every time the library reloads.
   */
  readonly graphs?: { readonly current: ReadonlyMap<string, unknown> | undefined };
  /**
   * The open project's folder.
   *
   * The queue is emptied when this changes. A take is a file in *that* project's `generated/` folder
   * and an accepted variant carries a project-relative path, so groups left over from the previous
   * project offered variants whose files are not where the new clip would look for them — and the
   * picker looked entirely normal while doing it.
   *
   * Not a dependency of the queue itself: rebuilding it would drop in-flight runs on the floor without
   * cancelling them, where `clear` cancels first and then forgets.
   */
  readonly projectRoot?: string | undefined;
}

export const DEFAULT_COMFYUI_ENDPOINT = 'http://127.0.0.1:8188';

/**
 * A `fetch` that routes through the desktop bridge.
 *
 * Shaped as a `fetch` so the ComfyUI backend needs no knowledge of Electron: it is written against the
 * standard interface and this substitutes the transport, which is exactly what the injected-transport
 * design was for.
 */
export function createProxyFetch(api: DesktopBridge, baseUrl: string): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
    const headers = new Headers(init?.headers ?? {});

    const response = await api.backendFetch(path, {
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(headers.get('content-type') !== null ? { contentType: headers.get('content-type') as string } : {}),
    });

    return new Response(response.body, {
      status: response.status === 0 ? 503 : response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/**
 * Reads ComfyUI's reply to an upload.
 *
 * Tolerant of a missing `subfolder`, which is the usual case, and of a body that is not JSON at all —
 * a reverse proxy in front of the backend answers with HTML when it is unhappy, and treating that as
 * a successful upload would submit a graph pointing at nothing.
 */
export function parseUpload(
  body: string,
): { readonly name: string; readonly subfolder?: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { name?: unknown; subfolder?: unknown };
    if (typeof parsed.name !== 'string' || parsed.name === '') return undefined;
    return typeof parsed.subfolder === 'string' && parsed.subfolder !== ''
      ? { name: parsed.name, subfolder: parsed.subfolder }
      : { name: parsed.name };
  } catch {
    return undefined;
  }
}

export function useGeneratorRuntime(options: RuntimeOptions = {}): GeneratorRuntime {
  const [configured, setConfigured] = useState<string | undefined>(undefined);
  const endpoint = options.endpoint ?? configured ?? DEFAULT_COMFYUI_ENDPOINT;
  const graphs = options.graphs;
  const projectRoot = options.projectRoot;

  // The endpoint is a main-process setting, so it is asked for rather than assumed.
  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;
    void api.backendConfig().then((config) => setConfigured(config.baseUrl));
  }, []);

  const proxyFetch = useMemo(() => {
    const api = bridge();
    // Outside Electron there is no proxy; the direct fetch is what the visual harness uses.
    return api === undefined ? globalThis.fetch.bind(globalThis) : createProxyFetch(api, endpoint);
  }, [endpoint]);

  const [mode, setMode] = useState<BackendMode>('mock');
  const [detail, setDetail] = useState('checking for a ComfyUI backend');
  const [capabilities, setCapabilities] = useState<BackendCapabilities | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(EMPTY_SNAPSHOT);
  const [error, setError] = useState<string | undefined>(undefined);

  // One id per window, so ComfyUI's shared event socket can be filtered to this client's jobs.
  const clientId = useRef(`nos-${Math.random().toString(36).slice(2, 10)}`);

  const comfy = useMemo(
    () =>
      createComfyUiBackend({
        endpoint: { baseUrl: endpoint },
        // The step that made a finished generation reachable at all: ComfyUI writes into its own
        // output directory, so without this a job completed, reported three files, showed three
        // variants — and none of them existed anywhere the application could read.
        download: async (query, destination) => {
          const api = bridge();
          if (api === undefined) {
            return { ok: false, error: { kind: 'unreachable', detail: 'no desktop bridge' } };
          }
          const result = await api.backendDownload(query, destination);
          return result.ok
            ? { ok: true, value: undefined }
            : { ok: false, error: { kind: 'unreachable', detail: result.body } };
        },
        // The counterpart to `download`, and the reason an image-to-video run failed with `a backend
        // path must start with "/"`: the old code read the project file *through the backend
        // transport*, which in the desktop is a proxy to ComfyUI — so it asked the render server for
        // a file sitting on the local disk. The bytes cross in the main process, which is also the
        // only side allowed to name a path on disk, and multipart bodies do not survive the proxy.
        upload: async ({ path, key }) => {
          const api = bridge();
          if (api === undefined) {
            return { ok: false, error: { kind: 'unreachable', detail: 'no desktop bridge' } };
          }
          const result = await api.backendUpload('/upload/image', path, 'image');
          if (!result.ok) {
            return { ok: false, error: { kind: 'upload-failed', key, detail: result.body } };
          }
          // ComfyUI answers with the name it filed the upload under, which is not always the name
          // sent — it renames on collision unless told to overwrite, and a graph pointing at the
          // name we chose would then load a different image.
          const stored = parseUpload(result.body);
          if (stored === undefined) {
            return {
              ok: false,
              error: {
                kind: 'upload-failed',
                key,
                detail: `unexpected upload reply: ${result.body.slice(0, 200)}`,
              },
            };
          }
          return { ok: true, value: stored };
        },
        transport: {
          // Every HTTP call goes through the main process. ComfyUI sends no CORS headers, so a direct
          // fetch from a `file://` renderer fails as "unreachable" with the server running perfectly —
          // and proxying keeps any basic-auth credentials out of this page. The WebSocket is opened
          // here because WebSockets are not subject to CORS.
          fetch: proxyFetch,
          openSocket: (url) => socketMessages(new WebSocket(url)),
        },
        clientId: clientId.current,
      }),
    [endpoint, proxyFetch],
  );

  const mock = useMemo(() => createMockBackend({ progressSteps: 4, stepDelayMs: 120 }), []);

  // Probed once per endpoint. `capabilities()` is the same call the registry needs for its `requires`
  // check, so reachability and the node-class list arrive together rather than as two round trips.
  useEffect(() => {
    let cancelled = false;
    void comfy.capabilities().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setMode('comfyui');
        setCapabilities(result.value);
        setDetail(`${result.value.nodeClasses.size} node classes at ${endpoint}`);
      } else {
        setMode('mock');
        setCapabilities(undefined);
        setDetail(`ComfyUI is unreachable at ${endpoint} — running against the mock backend`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [comfy, endpoint]);

  const backend: GeneratorBackend = mode === 'comfyui' ? comfy : mock;

  /*
   * One semaphore per window, created once.
   *
   * It used to be built inside the queue's `useMemo`, whose dependencies include the backend — so the
   * moment ComfyUI answered and the mode flipped from mock, a *second* semaphore replaced the first and
   * any lease held against the old one guarded nothing.
   */
  const gpuRef = useRef<GpuSemaphore | undefined>(undefined);
  gpuRef.current ??= createGpuSemaphore();
  const gpu = gpuRef.current;

  const queue = useMemo(
    () =>
      createJobQueue({
        backend,
        gpu,
        patcher: {
          patch(manifest, params, seeds) {
            const graph = graphs?.current?.get(manifest.graph ?? '');
            if (graph === undefined) {
              // Reaching a submit with no graph means the registry marked it available and the file
              // vanished since. Failing here is better than submitting an empty prompt.
              throw new Error(`the graph "${manifest.graph}" is not loaded`);
            }
            const patched = patchGraph({ manifest, graph, params, seeds });
            return { graph: patched.graph, assets: [...patched.assets] };
          },
        },
        nextSeed: () => Math.floor(Math.random() * 2 ** 31),
      }),
    [backend, graphs, gpu],
  );

  useEffect(() => queue.subscribe(setSnapshot), [queue]);

  /*
   * A change of project empties the queue.
   *
   * Skipped on the first root, which is the project opening rather than changing — clearing an empty
   * queue is harmless, but the effect reads as "on every project" if the guard is not spelt out.
   */
  const lastRoot = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastRoot.current !== undefined && lastRoot.current !== projectRoot) queue.clear();
    lastRoot.current = projectRoot;
  }, [projectRoot, queue]);

  const run = useCallback<GeneratorRuntime['run']>(
    (request) => {
      try {
        const group = queue.enqueue(request);
        setError(undefined);
        return group;
      } catch (failure) {
        // Reported, never swallowed. A Generate button that does nothing and says nothing is the exact
        // failure mode this project treats as a defect everywhere else.
        setError(failure instanceof Error ? failure.message : String(failure));
        return undefined;
      }
    },
    [queue],
  );

  const cancelGroup = useCallback((group: JobGroupId) => queue.cancelGroup(group), [queue]);
  const dismissGroup = useCallback((group: JobGroupId) => queue.dismissGroup(group), [queue]);

  return { mode, detail, error, capabilities, snapshot, gpu, run, cancelGroup, dismissGroup };
}
