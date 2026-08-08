import { type AssetPath, type Result, assetPath, err, ok } from '@nos/core';
import { applyUploadedAsset } from './graph-patcher.js';
import type {
  BackendCapabilities,
  BackendError,
  BackendJobId,
  BackendOutput,
  BackendProgress,
  GeneratorBackend,
  SubmitRequest,
} from '@nos/generators';

/**
 * The ComfyUI backend.
 *
 * Implements `GeneratorBackend` over the endpoints the spec lists:
 *
 * ```
 * POST /prompt                { prompt, client_id }  -> prompt_id
 * WS   /ws?clientId=...       progress, executing, executed
 * GET  /history/{prompt_id}   output filenames
 * GET  /view?filename=...     download
 * POST /upload/image          input assets
 * GET  /object_info           capabilities
 * ```
 *
 * It knows nothing about node semantics — only patching (done before it is called) and endpoint calls. That
 * is what keeps a second backend from touching the manifest layer or the UI.
 */

export interface ComfyUiEndpoint {
  /** Origin, no trailing slash. */
  readonly baseUrl: string;
  /** Optional basic-auth credentials, as supplied in `docs/comfy/credentials.txt`. */
  readonly username?: string;
  readonly password?: string;
}

/** The fetch and WebSocket surfaces this backend needs, injected for testability. */
export interface ComfyUiTransport {
  fetch: typeof globalThis.fetch;
  /** Opens the progress socket. Injected so tests need no real server. */
  openSocket(url: string): ComfyUiSocket;
}

export interface ComfyUiSocket {
  /** Yields raw messages until closed. */
  messages(): AsyncIterable<unknown>;
  close(): void;
}

export interface ComfyUiBackendOptions {
  readonly endpoint: ComfyUiEndpoint;
  readonly transport: ComfyUiTransport;
  /**
   * Identifies this client on the socket.
   *
   * ComfyUI multiplexes every client's events onto one stream, so without filtering by client id a second
   * editor window's progress would drive this one's bars.
   */
  readonly clientId: string;
  /** Where downloaded outputs land, project-relative. */
  readonly outputFolder?: string;
  /**
   * Copies a finished output out of the backend and into the project folder.
   *
   * Required, and the reason a generation used to end with nothing the user could reach: ComfyUI
   * writes into *its own* output directory, so a job could complete, report three files, show three
   * variants — and none of them existed anywhere the application could read. Injected because
   * writing to disk is the shell's privilege, not this package's.
   */
  readonly download: (query: string, destination: AssetPath) => Promise<Result<void, BackendError>>;

  /**
   * Sends a project file to the backend and reports the name it was stored under.
   *
   * Injected for the same reason `download` is, and for a second one: the file lives on the local
   * disk, not on the backend. Reading it through the backend transport was the bug — in the desktop
   * that transport is a proxy to ComfyUI, so an image-to-video run failed with `a backend path must
   * start with "/"` while pointing at a file that was sitting right there in the project.
   *
   * The returned name is the backend's, not the project's: ComfyUI stores an upload in its own input
   * directory and a graph must reference it by that name.
   */
  readonly upload: (asset: {
    readonly path: AssetPath;
    readonly key: string;
  }) => Promise<Result<UploadedAsset, BackendError>>;
}

/** What the backend stored an upload as. */
export interface UploadedAsset {
  /** Filename as the backend knows it, which is what a graph node must reference. */
  readonly name: string;
  /** Set when the backend filed it under a subfolder, which some nodes need spelled out. */
  readonly subfolder?: string;
}

interface HistoryEntry {
  readonly outputs?: Record<string, Record<string, readonly ComfyFileRef[]>>;
  readonly status?: { readonly status_str?: string; readonly completed?: boolean };
}

interface ComfyFileRef {
  readonly filename: string;
  readonly subfolder?: string;
  readonly type?: string;
}

/**
 * What each node in a submitted graph is called.
 *
 * ComfyUI's `executing` event names a node by **id** — `30:3`, or `54:14` for one inside a subgraph.
 * Reported as-is that produced status text reading `executing 54:14`, which tells a user nothing about
 * whether their job is loading a model or writing a file.
 *
 * The graph we submitted already holds the answer: every node carries a `_meta.title` the workflow's
 * author chose, and `30:3` is `KSampler`. Preferring the title over `class_type` is deliberate — an
 * author who renamed a node to `Remove background?` described that step better than its class does.
 *
 * A node that cannot be named is left out rather than guessed at, so the caller can fall back.
 */
export function graphNodeTitles(graph: unknown): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  if (typeof graph !== 'object' || graph === null) return titles;

  for (const [id, node] of Object.entries(graph as Record<string, unknown>)) {
    if (typeof node !== 'object' || node === null) continue;

    const meta = (node as { _meta?: unknown })._meta;
    const title = typeof meta === 'object' && meta !== null ? (meta as { title?: unknown }).title : undefined;
    const className = (node as { class_type?: unknown }).class_type;

    const name = typeof title === 'string' && title !== '' ? title : className;
    if (typeof name === 'string' && name !== '') titles.set(id, name);
  }

  return titles;
}

/**
 * The `/view` query for one output file.
 *
 * `subfolder` and `type` both matter: ComfyUI serves temp and output files from different roots, and
 * a preview node writes into a subfolder — omitting either returns a 404 for a file that is there.
 */
export function viewQuery(file: {
  readonly filename: string;
  readonly subfolder?: string;
  readonly type?: string;
}): string {
  const parameters = new URLSearchParams({ filename: file.filename });
  if (file.subfolder !== undefined && file.subfolder !== '') {
    parameters.set('subfolder', file.subfolder);
  }
  parameters.set('type', file.type ?? 'output');
  return `/view?${parameters.toString()}`;
}

export function createComfyUiBackend(options: ComfyUiBackendOptions): GeneratorBackend {
  const { endpoint, transport, clientId } = options;
  const outputFolder = options.outputFolder ?? 'generated';

  // Node names for jobs in flight, so `progress` can turn a node id into something readable. Kept per
  // job rather than globally because two runs of different generators are both in the queue and their
  // ids collide — `30:3` is a KSampler in one graph and a VAE Decode in another.
  const nodeNames = new Map<string, ReadonlyMap<string, string>>();

  function authHeaders(): Record<string, string> {
    if (endpoint.username === undefined || endpoint.password === undefined) return {};
    const encoded = btoa(`${endpoint.username}:${endpoint.password}`);
    return { authorization: `Basic ${encoded}` };
  }

  async function call<T>(path: string, init?: RequestInit): Promise<Result<T, BackendError>> {
    try {
      const response = await transport.fetch(`${endpoint.baseUrl}${path}`, {
        ...init,
        headers: { ...authHeaders(), ...(init?.headers ?? {}) },
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => `HTTP ${response.status}`);
        return err({ kind: 'rejected', detail: detail.slice(0, 500) });
      }
      return ok((await response.json()) as T);
    } catch (error) {
      return err({
        kind: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    id: 'comfyui',

    async submit(request: SubmitRequest): Promise<Result<BackendJobId, BackendError>> {
      // Uploads first, and the graph is rewritten with what each upload was named. Submitting before
      // they land would queue a prompt pointing at a file that does not exist yet; submitting without
      // the rewrite would queue one pointing at whatever the graph's author last saved — a run that
      // looks like it used your image and did not.
      let graph = request.graph;
      for (const asset of request.assets) {
        const uploaded = await options.upload({ path: assetPath(asset.path), key: asset.key });
        if (!uploaded.ok) return uploaded;
        graph = applyUploadedAsset(graph, asset, uploaded.value.name);
      }

      const submitted = await call<{ prompt_id?: string; error?: unknown }>('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
      });
      if (!submitted.ok) return submitted;

      const promptId = submitted.value.prompt_id;
      if (typeof promptId !== 'string') {
        // ComfyUI answers 200 with a validation error body for a bad graph, so a successful HTTP status is
        // not proof the job was accepted.
        return err({
          kind: 'rejected',
          detail: JSON.stringify(submitted.value.error ?? submitted.value).slice(0, 500),
        });
      }

      // Read from the rewritten graph, which is the one ComfyUI is running.
      nodeNames.set(promptId, graphNodeTitles(graph));
      return ok(promptId);
    },

    async *progress(job: BackendJobId): AsyncIterable<BackendProgress> {
      const socket = transport.openSocket(
        `${endpoint.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`,
      );

      try {
        for await (const raw of socket.messages()) {
          const event = parseSocketEvent(raw);
          if (event === undefined) continue;
          // Events for other prompts share the socket; without this filter a second window's job would
          // drive this one's progress bar.
          if (event.promptId !== undefined && event.promptId !== job) continue;

          if (event.kind === 'progress') {
            yield {
              fraction: event.max > 0 ? event.value / event.max : 0,
              stage: 'sampling',
            };
          } else if (event.kind === 'executing') {
            if (event.node === null) return;
            // The id only when the graph does not name the node — a subgraph ComfyUI expanded after we
            // submitted, say. Something opaque still beats a stage that stops updating.
            yield { stage: nodeNames.get(job)?.get(event.node) ?? `executing ${event.node}` };
          } else if (event.kind === 'execution-error') {
            return;
          }
        }
      } finally {
        // Always closed, including on an early `return` from the consumer breaking out of `for await`.
        socket.close();
      }
    },

    async collect(job: BackendJobId): Promise<Result<readonly BackendOutput[], BackendError>> {
      // Collecting is the end of a job whichever way it went, so the names it no longer needs go here
      // rather than in `progress` — a consumer that breaks out of the progress loop early and resumes
      // would otherwise find the stage had gone back to raw ids.
      nodeNames.delete(job);

      const history = await call<Record<string, HistoryEntry>>(`/history/${job}`);
      if (!history.ok) return history;

      const entry = history.value[job];
      if (entry === undefined) {
        return err({ kind: 'no-outputs', detail: `history has no entry for ${job}` });
      }

      const status = entry.status?.status_str;
      if (status === 'error') {
        return err({ kind: 'execution-failed', detail: `the graph reported an error for ${job}` });
      }

      const outputs: BackendOutput[] = [];
      for (const [nodeId, nodeOutputs] of Object.entries(entry.outputs ?? {})) {
        for (const [outputKey, files] of Object.entries(nodeOutputs)) {
          for (const file of files ?? []) {
            if (typeof file?.filename !== 'string') continue;

            // The filename alone would collide across jobs — ComfyUI names by prefix and counter, and
            // two runs of one generator produce `sfx_00001_.flac` twice. Prefixing with the job keeps
            // a variant set distinguishable in `generated/` after the fact.
            const destination = assetPath(`${outputFolder}/${job}_${file.filename}`);
            const copied = await options.download(viewQuery(file), destination);
            if (!copied.ok) return copied;

            outputs.push({
              // Keyed by node so the manifest's `outputs[].node` can match it. The manifest, not the
              // backend, decides what an output *means*.
              key: nodeId,
              type: guessType(file.filename, outputKey),
              path: destination,
            });
          }
        }
      }

      if (outputs.length === 0) {
        return err({ kind: 'no-outputs', detail: `${job} finished with no files` });
      }
      return ok(outputs);
    },

    async cancel(job: BackendJobId): Promise<void> {
      // A cancelled job may never be collected, so it is dropped here too.
      nodeNames.delete(job);

      // Two calls, because ComfyUI distinguishes them: `interrupt` stops what is executing, `queue` with a
      // delete removes one that has not started. Cancelling a queued job with `interrupt` alone would stop
      // whatever is running instead — someone else's job.
      await call('/interrupt', { method: 'POST' }).catch(() => undefined);
      await call('/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: [job] }),
      }).catch(() => undefined);
    },

    async capabilities(): Promise<Result<BackendCapabilities, BackendError>> {
      const info = await call<Record<string, ObjectInfoNode>>('/object_info');
      if (!info.ok) return info;

      const nodeClasses = new Set(Object.keys(info.value));
      const enumOptions = new Map<string, readonly string[]>();

      for (const [nodeClass, node] of Object.entries(info.value)) {
        const required = node?.input?.required ?? {};
        for (const [inputName, spec] of Object.entries(required)) {
          const options = enumOptionsOf(spec);
          if (options !== undefined) enumOptions.set(`${nodeClass}/${inputName}`, options);
        }
      }

      return ok({ nodeClasses, enumOptions });
    },
  };
}

/**
 * The options of an enum input, in either shape ComfyUI declares them.
 *
 * It has two. The long-standing one puts the options where the type goes — `[[a, b, c], {…}]` — and
 * newer versions name the type and move the options into the metadata: `['COMBO', { options: […] }]`.
 *
 * Only the first was understood, and the consequence was quiet and total: against a current
 * ComfyUI *every* live dropdown in the application was empty, so a manifest that deferred its
 * options to the backend produced a control with nothing in it. The report was that a generator's
 * resolution could not be set; the cause was that no live enum anywhere could be.
 *
 * Both are accepted rather than the newer one alone, because the two exist in the wild at once and a
 * client that only understood the current one would break against the next long-term release.
 */
export function enumOptionsOf(spec: unknown): readonly string[] | undefined {
  if (!Array.isArray(spec)) return undefined;

  const [type, metadata] = spec as [unknown, unknown];
  if (Array.isArray(type) && type.every((value) => typeof value === 'string')) {
    return type as readonly string[];
  }

  if (metadata !== null && typeof metadata === 'object') {
    const options = (metadata as { options?: unknown }).options;
    if (Array.isArray(options) && options.every((value) => typeof value === 'string')) {
      return options as readonly string[];
    }
  }

  return undefined;
}

interface ObjectInfoNode {
  readonly input?: { readonly required?: Record<string, unknown> };
}

type SocketEvent =
  | { readonly kind: 'progress'; readonly value: number; readonly max: number; readonly promptId?: string }
  | { readonly kind: 'executing'; readonly node: string | null; readonly promptId?: string }
  | { readonly kind: 'executed'; readonly promptId?: string }
  | { readonly kind: 'execution-error'; readonly promptId?: string };

/**
 * Parses a ComfyUI socket message.
 *
 * Tolerant by design: the server emits event types this client does not model, and new ones appear across
 * versions. An unrecognized message is ignored rather than treated as an error, or a ComfyUI upgrade would
 * break generation.
 */
export function parseSocketEvent(raw: unknown): SocketEvent | undefined {
  const message = typeof raw === 'string' ? safeParse(raw) : raw;
  if (message === null || typeof message !== 'object') return undefined;

  const { type, data } = message as { type?: unknown; data?: unknown };
  if (typeof type !== 'string') return undefined;
  const payload = (data ?? {}) as Record<string, unknown>;
  const promptId = typeof payload['prompt_id'] === 'string' ? payload['prompt_id'] : undefined;

  switch (type) {
    case 'progress':
      return {
        kind: 'progress',
        value: typeof payload['value'] === 'number' ? payload['value'] : 0,
        max: typeof payload['max'] === 'number' ? payload['max'] : 0,
        ...(promptId !== undefined ? { promptId } : {}),
      };
    case 'executing':
      return {
        kind: 'executing',
        // A null node is ComfyUI's end-of-execution signal, which is how the progress stream knows to stop.
        node: typeof payload['node'] === 'string' ? payload['node'] : null,
        ...(promptId !== undefined ? { promptId } : {}),
      };
    case 'executed':
      return { kind: 'executed', ...(promptId !== undefined ? { promptId } : {}) };
    case 'execution_error':
    case 'execution_interrupted':
      return { kind: 'execution-error', ...(promptId !== undefined ? { promptId } : {}) };
    default:
      return undefined;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Infers an asset type from an output filename.
 *
 * A guess, corrected by the manifest: `outputs[].type` is authoritative because the manifest author knows
 * what the graph produces. This only has to be right often enough for a log line to read sensibly.
 */
function guessType(filename: string, outputKey: string): BackendOutput['type'] {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (['mp4', 'webm', 'mov', 'mkv'].includes(extension)) return 'video';
  if (['flac', 'wav', 'mp3', 'ogg', 'opus'].includes(extension)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return 'image';
  if (outputKey === 'text' || extension === 'txt' || extension === 'json') return 'text';
  return 'image';
}
