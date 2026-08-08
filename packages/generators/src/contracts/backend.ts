import type { AssetPath, AssetType, Result } from '@nos/core';

/**
 * The backend runner contract.
 *
 * The spec fixes this surface — `submit` / `progress` / `collect` / `cancel` / `capabilities` — and states
 * that another backend must be attachable **without changing the manifests or the UI**. That is the whole
 * reason it is this small: everything a backend does that is specific to it (patching a graph, speaking a
 * protocol, uploading assets) happens behind these five calls.
 *
 * Notably absent: anything about graphs. The queue hands over a *patched* graph and gets outputs back. A
 * backend that is not graph-based at all would implement the same interface.
 */

/** Opaque handle for a submitted job. Its shape is the backend's business. */
export type BackendJobId = string;

export interface SubmitRequest {
  /** The graph, already patched with this run's parameters. */
  readonly graph: unknown;
  /** Assets the backend must have before running, e.g. a first frame to upload. */
  readonly assets: readonly BackendAsset[];
}

export interface BackendAsset {
  /** Parameter key this asset satisfies, so the backend can report which upload failed. */
  readonly key: string;
  readonly path: AssetPath;
  /** Transport declared by the manifest, e.g. `upload_image`. */
  readonly transport: string;
}

/** A progress event. Backends emit these as they run. */
export interface BackendProgress {
  /** `[0, 1]`, or `undefined` when the backend cannot estimate. */
  readonly fraction?: number;
  /** What is happening, e.g. `sampling`, `decoding`, `uploading`. */
  readonly stage?: string;
  /**
   * A preview frame, when the backend can provide one.
   *
   * Optional because most cannot, and a UI that assumed previews would show a permanently empty box for
   * the ones that do not.
   */
  readonly preview?: ArrayBuffer;
}

/** One file a run produced. */
export interface BackendOutput {
  /** Which declared output this satisfies. */
  readonly key: string;
  readonly type: AssetType;
  /** Where the backend put it, relative to the project. */
  readonly path: AssetPath;
}

export type BackendError =
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'rejected'; readonly detail: string }
  | { readonly kind: 'execution-failed'; readonly detail: string }
  | { readonly kind: 'upload-failed'; readonly key: string; readonly detail: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-outputs'; readonly detail: string };

export function describeBackendError(error: BackendError): string {
  switch (error.kind) {
    case 'unreachable':
      return `the backend is not reachable: ${error.detail}`;
    case 'rejected':
      return `the backend rejected the job: ${error.detail}`;
    case 'execution-failed':
      return `the graph failed: ${error.detail}`;
    case 'upload-failed':
      return `uploading "${error.key}" failed: ${error.detail}`;
    case 'cancelled':
      return 'cancelled';
    case 'no-outputs':
      return `the job finished but produced nothing: ${error.detail}`;
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled backend error ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * What a backend can do.
 *
 * Drives two things: the registry's `requires` check, and `enum` parameters declaring
 * `options: { from: "capabilities" }` — the spec's mechanism for model and sampler lists that reflect
 * reality rather than a manifest written six months ago.
 */
export interface BackendCapabilities {
  readonly nodeClasses: ReadonlySet<string>;
  /**
   * Enum options per node class and input, e.g. the checkpoint list.
   *
   * Keyed `nodeClass/input` so a manifest's `{ from: "capabilities", nodeClass, input }` resolves with a
   * single lookup.
   */
  readonly enumOptions: ReadonlyMap<string, readonly string[]>;
}

export interface GeneratorBackend {
  readonly id: string;
  submit(request: SubmitRequest): Promise<Result<BackendJobId, BackendError>>;
  /**
   * Progress events until the job settles.
   *
   * An async iterable rather than a callback: the consumer can stop iterating to detach, and `for await`
   * with a `finally` makes cleanup obvious at the call site.
   */
  progress(job: BackendJobId): AsyncIterable<BackendProgress>;
  collect(job: BackendJobId): Promise<Result<readonly BackendOutput[], BackendError>>;
  cancel(job: BackendJobId): Promise<void>;
  capabilities(): Promise<Result<BackendCapabilities, BackendError>>;
}

/** Looks up live enum options for a parameter. */
export function capabilityOptions(
  capabilities: BackendCapabilities,
  nodeClass: string | undefined,
  input: string | undefined,
): readonly string[] {
  if (nodeClass === undefined || input === undefined) return [];
  return capabilities.enumOptions.get(`${nodeClass}/${input}`) ?? [];
}
