import { type Result, assetPath, err, ok } from '@nos/core';
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

export function createComfyUiBackend(options: ComfyUiBackendOptions): GeneratorBackend {
  const { endpoint, transport, clientId } = options;
  const outputFolder = options.outputFolder ?? 'generated';

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
      // Uploads first: the graph references them by the filename the server assigns, so submitting before
      // they land would queue a prompt pointing at a file that does not exist yet.
      for (const asset of request.assets) {
        const uploaded = await uploadAsset(asset.path, asset.key);
        if (!uploaded.ok) return uploaded;
      }

      const submitted = await call<{ prompt_id?: string; error?: unknown }>('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: request.graph, client_id: clientId }),
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
            yield { stage: `executing ${event.node}` };
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
            outputs.push({
              // Keyed by node so the manifest's `outputs[].node` can match it. The manifest, not the
              // backend, decides what an output *means*.
              key: nodeId,
              type: guessType(file.filename, outputKey),
              path: assetPath(`${outputFolder}/${file.filename}`),
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
          // An enum input is declared as `[[option, ...], {...}]`; anything else is a scalar type.
          const options = Array.isArray(spec) ? spec[0] : undefined;
          if (Array.isArray(options) && options.every((value) => typeof value === 'string')) {
            enumOptions.set(`${nodeClass}/${inputName}`, options as readonly string[]);
          }
        }
      }

      return ok({ nodeClasses, enumOptions });
    },
  };

  async function uploadAsset(path: string, key: string): Promise<Result<void, BackendError>> {
    try {
      const file = await transport.fetch(path);
      if (!file.ok) {
        return err({ kind: 'upload-failed', key, detail: `could not read ${path}` });
      }
      const body = new FormData();
      body.append('image', await file.blob(), path.split('/').pop() ?? 'upload');
      // `overwrite` keeps repeated runs from accumulating `file (1).png` copies server-side, which would
      // then no longer match the filename patched into the graph.
      body.append('overwrite', 'true');

      const response = await transport.fetch(`${endpoint.baseUrl}/upload/image`, {
        method: 'POST',
        headers: authHeaders(),
        body,
      });
      if (!response.ok) {
        return err({ kind: 'upload-failed', key, detail: `HTTP ${response.status}` });
      }
      return ok(undefined);
    } catch (error) {
      return err({
        kind: 'upload-failed',
        key,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
