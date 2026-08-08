import { type Result, err, ok } from '@nos/core';

/**
 * HTTP transport to the sidecar.
 *
 * One place owns the token header, the JSON envelope and the translation of a transport failure
 * into a typed value. Everything above this file works with `Result`, so a dead sidecar and a
 * rejected path are handled by the same code path as a success — no try/catch scattered through
 * the services.
 */

export interface SidecarEndpoint {
  /** Origin only, no trailing slash: `http://127.0.0.1:43101`. */
  readonly baseUrl: string;
  /** Shared secret handed to the sidecar at spawn. */
  readonly token: string;
}

/**
 * Structured error body the sidecar returns.
 *
 * `kind` mirrors the Python `MediaError` discriminants, so callers branch on a stable string
 * rather than on a status code or a message substring.
 */
export interface SidecarErrorBody {
  readonly kind: string;
  readonly detail: string;
}

export type TransportError =
  /** The sidecar is not reachable at all — not started, or already exited. */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** The request was cancelled by the caller. */
  | { readonly kind: 'aborted' }
  /** Wrong or missing token. A bug in the wiring, never something a user can cause. */
  | { readonly kind: 'unauthorized' }
  /** The sidecar answered with a structured error. */
  | { readonly kind: 'rejected'; readonly status: number; readonly body: SidecarErrorBody }
  /** The sidecar answered, but not with something we can parse. */
  | { readonly kind: 'malformed-response'; readonly detail: string };

export interface RequestOptions {
  readonly signal?: AbortSignal;
  /**
   * Per-request timeout.
   *
   * Needed because a hung ffmpeg would otherwise leave the request pending forever, and the UI
   * would show an import spinner with no way out. Long-running derivations pass a generous value
   * rather than none.
   */
  readonly timeoutMs?: number;
}

/** The fetch surface this client needs. Injected so tests need no network and no server. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SidecarTransport {
  postJson<T>(path: string, body: unknown, options?: RequestOptions): Promise<Result<T, TransportError>>;
  getJson<T>(path: string, options?: RequestOptions): Promise<Result<T, TransportError>>;
  getBinary(path: string, options?: RequestOptions): Promise<Result<ArrayBuffer, TransportError>>;
  /** Absolute URL for an asset, for `<video>` and `<img>` sources that cannot send headers. */
  fileUrl(asset: string): string;
  readonly endpoint: SidecarEndpoint;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createTransport(endpoint: SidecarEndpoint, fetchImpl: FetchLike): SidecarTransport {
  async function request<T>(
    path: string,
    init: { method: string; body?: unknown },
    options: RequestOptions,
    parse: 'json' | 'binary',
  ): Promise<Result<T, TransportError>> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Two abort sources — the caller's signal and the timeout — funnelled into one controller, so
    // the reason can be distinguished afterwards. Without tracking which fired, a timeout would be
    // reported as a user cancellation and silently swallowed by the UI.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onCallerAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      const response = await fetchImpl(`${endpoint.baseUrl}${path}`, {
        method: init.method,
        headers: {
          'X-Nos-Token': endpoint.token,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });

      if (response.status === 401) return err({ kind: 'unauthorized' });

      if (!response.ok) {
        return err({
          kind: 'rejected',
          status: response.status,
          body: await readErrorBody(response),
        });
      }

      if (parse === 'binary') {
        return ok((await response.arrayBuffer()) as T);
      }

      try {
        return ok((await response.json()) as T);
      } catch (error) {
        return err({ kind: 'malformed-response', detail: describe(error) });
      }
    } catch (error) {
      if (timedOut) {
        return err({
          kind: 'unreachable',
          detail: `request to ${path} timed out after ${timeoutMs}ms`,
        });
      }
      if (isAbortError(error) || options.signal?.aborted === true) {
        return err({ kind: 'aborted' });
      }
      return err({ kind: 'unreachable', detail: describe(error) });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  return {
    endpoint,

    postJson: (path, body, options = {}) => request(path, { method: 'POST', body }, options, 'json'),

    getJson: (path, options = {}) => request(path, { method: 'GET' }, options, 'json'),

    getBinary: (path, options = {}) => request(path, { method: 'GET' }, options, 'binary'),

    fileUrl(asset) {
      // The token rides as a query parameter here, unlike every other call, because `<video src>`
      // and `<img src>` cannot carry headers. Acceptable only because the endpoint is loopback and
      // the URL never leaves the renderer process.
      const params = new URLSearchParams({ asset, token: endpoint.token });
      return `${endpoint.baseUrl}/media/file?${params.toString()}`;
    },
  };
}

async function readErrorBody(response: FetchLikeResponse): Promise<SidecarErrorBody> {
  try {
    const parsed = await response.json();
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { kind?: unknown }).kind === 'string' &&
      typeof (parsed as { detail?: unknown }).detail === 'string'
    ) {
      return parsed as SidecarErrorBody;
    }
    // FastAPI's own validation errors use `detail` as an array. Preserve them rather than
    // discarding, because they name the offending field.
    return { kind: 'invalid-request', detail: JSON.stringify(parsed) };
  } catch {
    return { kind: 'unknown', detail: `HTTP ${response.status}` };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Message suitable for a dialog or a log line. */
export function describeTransportError(error: TransportError): string {
  switch (error.kind) {
    case 'unreachable':
      return `The media service is not responding: ${error.detail}`;
    case 'aborted':
      return 'The request was cancelled';
    case 'unauthorized':
      return 'The media service rejected our credentials';
    case 'rejected':
      return error.body.detail;
    case 'malformed-response':
      return `The media service returned an unreadable response: ${error.detail}`;
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled transport error ${JSON.stringify(unreachable)}`);
    }
  }
}
