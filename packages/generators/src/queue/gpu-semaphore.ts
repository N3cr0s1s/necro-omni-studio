/**
 * The GPU semaphore.
 *
 * The spec names three consumers competing for VRAM: the generator backend, the SAM 2 segmentation worker,
 * and the LLMs embedded in generator graphs for prompt expansion. It requires one central semaphore, and
 * that they be **serialized**.
 *
 * Serialized rather than pooled, because the failure mode is not slowness — it is an out-of-memory abort
 * partway through a job the user has already waited minutes for. A queue that is occasionally idle is a
 * far better trade than a job that dies at 80%.
 *
 * The holder is exposed deliberately: the mockups show generator jobs waiting while segmentation holds the
 * GPU, stated rather than hidden. A progress bar that stops with no explanation reads as a hang.
 */

export type GpuConsumer = 'generator' | 'segmentation' | 'llm' | 'export';

export interface GpuLease {
  readonly consumer: GpuConsumer;
  /** What is running, for the status readout: a generator id, a mask range. */
  readonly label: string;
  readonly acquiredAt: number;
  /** Releases the lease. Idempotent — a double release must not free someone else's turn. */
  release(): void;
}

export interface GpuWaiter {
  readonly consumer: GpuConsumer;
  readonly label: string;
  readonly since: number;
}

export interface GpuStatus {
  readonly holder?: { readonly consumer: GpuConsumer; readonly label: string };
  readonly waiting: readonly GpuWaiter[];
}

export interface GpuSemaphore {
  /**
   * Waits for exclusive GPU access.
   *
   * Resolves with a lease that must be released. An aborted request rejects, so a cancelled job does not
   * take a turn it no longer wants — otherwise cancelling a queued job would still block everything behind
   * it for the duration of its run.
   */
  acquire(consumer: GpuConsumer, label: string, signal?: AbortSignal): Promise<GpuLease>;
  getStatus(): GpuStatus;
  subscribe(listener: (status: GpuStatus) => void): () => void;
}

interface PendingRequest {
  readonly consumer: GpuConsumer;
  readonly label: string;
  readonly since: number;
  readonly resolve: (lease: GpuLease) => void;
  readonly reject: (reason: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export class GpuAbortError extends Error {
  constructor() {
    super('the GPU request was cancelled before it was granted');
    this.name = 'GpuAbortError';
  }
}

export function createGpuSemaphore(now: () => number = () => Date.now()): GpuSemaphore {
  const queue: PendingRequest[] = [];
  const listeners = new Set<(status: GpuStatus) => void>();
  let holder: { consumer: GpuConsumer; label: string } | undefined;

  function build(): GpuStatus {
    return {
      ...(holder !== undefined ? { holder: { ...holder } } : {}),
      waiting: queue.map((request) => ({
        consumer: request.consumer,
        label: request.label,
        since: request.since,
      })),
    };
  }

  /*
   * The current snapshot, held rather than rebuilt per call.
   *
   * `getStatus` used to construct a fresh object every time, which is fine for a caller that reads it
   * once and wrong for the thing a subscribe/getSnapshot pair *is*: React's `useSyncExternalStore`
   * compares snapshots by identity to decide whether to re-render, so a store that never returns the
   * same object twice reports a change on every render — an infinite loop rather than a stale value.
   *
   * A store that publishes to listeners owes them a stable value between publishes. Rebuilt in
   * `publish` and nowhere else, so the identity changes exactly when the state does.
   */
  let snapshot: GpuStatus = build();

  function status(): GpuStatus {
    return snapshot;
  }

  function publish(): void {
    snapshot = build();
    for (const listener of [...listeners]) listener(snapshot);
  }

  function grant(request: PendingRequest): void {
    holder = { consumer: request.consumer, label: request.label };
    request.onAbort !== undefined && request.signal?.removeEventListener('abort', request.onAbort);

    let released = false;
    request.resolve({
      consumer: request.consumer,
      label: request.label,
      acquiredAt: now(),
      release(): void {
        // Idempotent: a caller releasing twice — a `finally` plus an explicit release, say — must not hand
        // the next turn out twice and let two jobs run concurrently.
        if (released) return;
        released = true;
        holder = undefined;
        pump();
        publish();
      },
    });
    publish();
  }

  function pump(): void {
    if (holder !== undefined) return;
    const next = queue.shift();
    if (next === undefined) return;
    grant(next);
  }

  return {
    acquire(consumer, label, signal): Promise<GpuLease> {
      if (signal?.aborted === true) return Promise.reject(new GpuAbortError());

      return new Promise<GpuLease>((resolve, reject) => {
        const request: PendingRequest = {
          consumer,
          label,
          since: now(),
          resolve,
          reject,
          ...(signal !== undefined ? { signal } : {}),
        };

        if (signal !== undefined) {
          const onAbort = (): void => {
            const index = queue.indexOf(mutable);
            if (index >= 0) {
              queue.splice(index, 1);
              reject(new GpuAbortError());
              publish();
            }
          };
          // Assigned after construction so `onAbort` can close over the request it belongs to.
          const mutable = { ...request, onAbort };
          signal.addEventListener('abort', onAbort, { once: true });
          queue.push(mutable);
        } else {
          queue.push(request);
        }

        if (holder === undefined) pump();
        else publish();
      });
    },

    getStatus: status,

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** `GPU busy · segmentation` style readout for the title bar. */
export function describeGpuStatus(status: GpuStatus): string {
  if (status.holder === undefined) {
    return status.waiting.length === 0 ? 'GPU idle' : `GPU idle · ${status.waiting.length} queued`;
  }
  const queued = status.waiting.length === 0 ? '' : ` · ${status.waiting.length} queued`;
  return `GPU busy · ${status.holder.consumer}${queued}`;
}

/**
 * Runs work while holding the GPU.
 *
 * The release lives in a `finally`, so work that throws cannot strand the semaphore — a leaked lease would
 * deadlock every generator, every mask and every export for the rest of the session, which is the single
 * worst failure this component can have.
 */
export async function withGpu<T>(
  semaphore: GpuSemaphore,
  consumer: GpuConsumer,
  label: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lease = await semaphore.acquire(consumer, label, signal);
  try {
    return await work();
  } finally {
    lease.release();
  }
}
