import { type AssetPath, type Result, assetPath, err, ok } from '@nos/core';
import type {
  BackendCapabilities,
  BackendError,
  BackendJobId,
  BackendOutput,
  BackendProgress,
  GeneratorBackend,
  SubmitRequest,
} from '../contracts/backend.js';

/**
 * An in-memory backend.
 *
 * The spec separates M9 and M10 deliberately: "the framework is finished and testable with a mock backend
 * before any concrete graph is connected". This is that mock, and it is a shipped artifact rather than a
 * test fixture — it is also what makes the framework demonstrable without a GPU, and what a contributor
 * uses to work on the queue or the panel without ComfyUI running.
 *
 * It is deliberately *capable of misbehaving*: configurable failures, delays and cancellation are how the
 * queue's error paths get exercised. A mock that only ever succeeds would leave the interesting half of
 * the queue untested.
 */

export interface MockBackendOptions {
  readonly id?: string;
  /** Progress events emitted per job, before completion. */
  readonly progressSteps?: number;
  /** Milliseconds between progress events. Zero keeps tests fast. */
  readonly stepDelayMs?: number;
  /** Outputs to report. Defaults to one file named after the job. */
  readonly outputs?: readonly BackendOutput[];
  readonly capabilities?: BackendCapabilities;
  /**
   * Fails the nth submit, counting from one.
   *
   * Chosen over a "fail everything" switch because the interesting case is one variant of three failing —
   * which is what exercises the queue's `partial` status.
   */
  readonly failSubmitOn?: readonly number[];
  readonly failCollectOn?: readonly number[];
  /** Simulates the backend being unreachable. */
  readonly unreachable?: boolean;
}

export interface MockBackend extends GeneratorBackend {
  /** Every graph submitted, so a test can assert what was patched. */
  readonly submissions: readonly SubmitRequest[];
  readonly cancelled: readonly BackendJobId[];
  /** Releases a job that was created with `manualCompletion`. */
  complete(job: BackendJobId): void;
}

export function createMockBackend(options: MockBackendOptions = {}): MockBackend {
  const id = options.id ?? 'mock';
  const progressSteps = options.progressSteps ?? 2;
  const stepDelayMs = options.stepDelayMs ?? 0;
  const failSubmitOn = new Set(options.failSubmitOn ?? []);
  const failCollectOn = new Set(options.failCollectOn ?? []);

  const submissions: SubmitRequest[] = [];
  const cancelled: BackendJobId[] = [];
  const jobIndex = new Map<string, number>();
  let submitCount = 0;

  return {
    id,
    submissions,
    cancelled,

    async submit(request: SubmitRequest): Promise<Result<BackendJobId, BackendError>> {
      if (options.unreachable === true) {
        return err({ kind: 'unreachable', detail: 'the mock backend is configured as unreachable' });
      }

      submitCount += 1;
      submissions.push(request);

      if (failSubmitOn.has(submitCount)) {
        return err({ kind: 'rejected', detail: `mock rejected submit #${submitCount}` });
      }

      const job = `${id}-job-${submitCount}`;
      jobIndex.set(job, submitCount);
      return ok(job);
    },

    async *progress(job: BackendJobId): AsyncIterable<BackendProgress> {
      for (let step = 1; step <= progressSteps; step += 1) {
        if (cancelled.includes(job)) return;
        if (stepDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
        }
        yield { fraction: step / progressSteps, stage: step === progressSteps ? 'finishing' : 'running' };
      }
    },

    async collect(job: BackendJobId): Promise<Result<readonly BackendOutput[], BackendError>> {
      const index = jobIndex.get(job) ?? 0;
      if (failCollectOn.has(index)) {
        return err({ kind: 'execution-failed', detail: `mock failed collect for ${job}` });
      }
      if (cancelled.includes(job)) {
        return err({ kind: 'cancelled' });
      }

      const outputs =
        options.outputs ??
        ([
          {
            key: 'output',
            type: 'audio' as const,
            path: mockOutputPath(job),
          },
        ] satisfies readonly BackendOutput[]);
      return ok(outputs);
    },

    async cancel(job: BackendJobId): Promise<void> {
      cancelled.push(job);
    },

    async capabilities(): Promise<Result<BackendCapabilities, BackendError>> {
      if (options.unreachable === true) {
        return err({ kind: 'unreachable', detail: 'the mock backend is configured as unreachable' });
      }
      return ok(
        options.capabilities ?? {
          nodeClasses: new Set<string>(),
          enumOptions: new Map<string, readonly string[]>(),
        },
      );
    },

    complete(): void {
      // Present for symmetry with a future manual-completion mode; the current mock always progresses to
      // completion on its own.
    },
  };
}

function mockOutputPath(job: BackendJobId): AssetPath {
  // Under `generated/`, matching where a real backend's output lands, so an importer under test sees a
  // realistic path rather than one it would never encounter.
  return assetPath(`generated/${job}.flac`);
}

/**
 * A patcher that records rather than patches.
 *
 * Lets the queue be exercised with no graph at all. It returns the parameters it was given as the "graph",
 * so a test can assert that the right seed reached the right run without parsing anything.
 */
export function createRecordingPatcher(): {
  patch: (
    manifest: { readonly id: string },
    params: Readonly<Record<string, string | number | boolean>>,
    seeds: readonly number[],
  ) => {
    graph: unknown;
    assets: readonly { key: string; path: string; transport: string; bind: string | null }[];
  };
  readonly calls: readonly { generator: string; params: unknown; seeds: readonly number[] }[];
} {
  const calls: { generator: string; params: unknown; seeds: readonly number[] }[] = [];
  return {
    calls,
    patch(manifest, params, seeds) {
      calls.push({ generator: manifest.id, params, seeds });
      return { graph: { generator: manifest.id, params, seeds }, assets: [] };
    },
  };
}
