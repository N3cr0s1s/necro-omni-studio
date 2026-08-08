import {
  type FrameIndex,
  type GeneratorId,
  type JobGroupId,
  type JobRunId,
  type PresetId,
  type TrackId,
  jobGroupId,
  jobRunId,
} from '@nos/core';
import type { BackendOutput, GeneratorBackend } from '../contracts/backend.js';
import { describeBackendError } from '../contracts/backend.js';
import type { GeneratorManifest } from '../contracts/manifest.js';
import { type GpuSemaphore, withGpu } from './gpu-semaphore.js';
import { type VariantPlan, planVariants } from './variant-plan.js';

/**
 * The job queue.
 *
 * The spec's model: **one queue for every generator type**, with two levels.
 *
 * - A **group** is one user request: a generator, a preset, parameters, a variant count, a target.
 * - A **run** is one variant: a seed, a status, progress, outputs.
 *
 * One queue rather than per-type queues because the machinery is genuinely identical — only the importer
 * that lands the output differs — and because the GPU semaphore has to serialize across all of them
 * anyway. A per-type queue would just be a second place for the same bug.
 *
 * The group/run split is what makes partial results usable, which the spec calls for explicitly: a run
 * that finishes is immediately auditionable while its siblings are still going.
 */

export type RunStatus = 'queued' | 'waiting-for-gpu' | 'running' | 'complete' | 'failed' | 'cancelled';
export type GroupStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';

/** Where a group's output should land. */
export type JobTarget =
  | { readonly kind: 'media-browser' }
  | {
      readonly kind: 'timeline';
      readonly track: TrackId;
      readonly at: FrameIndex;
    };

export interface JobRun {
  readonly id: JobRunId;
  readonly group: JobGroupId;
  readonly seed: number;
  /** Seeds in this submit. More than one only in batched mode. */
  readonly seeds: readonly number[];
  readonly status: RunStatus;
  /** `[0, 1]`, or `undefined` before the backend reports. */
  readonly progress?: number;
  readonly stage?: string;
  readonly outputs: readonly BackendOutput[];
  readonly error?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export interface JobGroup {
  readonly id: JobGroupId;
  readonly generator: GeneratorId;
  readonly preset?: PresetId;
  readonly label: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly variantCount: number;
  readonly target: JobTarget;
  readonly status: GroupStatus;
  readonly runs: readonly JobRunId[];
  /** Why the variant count differs from what was asked, if it does. */
  readonly constraintNote?: string;
  readonly createdAt: number;
}

export interface QueueSnapshot {
  readonly groups: readonly JobGroup[];
  readonly runs: readonly JobRun[];
  /** Runs not yet finished, for the `2 jobs` chip in the title bar. */
  readonly activeCount: number;
}

export interface EnqueueRequest {
  readonly manifest: GeneratorManifest;
  readonly preset?: PresetId;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly target: JobTarget;
  readonly variantCount?: number;
  readonly lockedSeed?: number;
}

/**
 * Patches a graph for one run.
 *
 * Injected rather than implemented here: patching is backend-specific, and the queue's job is scheduling.
 * Keeping it out means the queue can be tested with a mock backend and no graph at all — which is exactly
 * how the spec wants M9 verified before M10 exists.
 */
export interface GraphPatcher {
  patch(
    manifest: GeneratorManifest,
    params: Readonly<Record<string, string | number | boolean>>,
    seeds: readonly number[],
  ): {
    readonly graph: unknown;
    readonly assets: readonly { key: string; path: string; transport: string }[];
  };
}

export interface JobQueueOptions {
  readonly backend: GeneratorBackend;
  readonly gpu: GpuSemaphore;
  readonly patcher: GraphPatcher;
  readonly nextSeed: () => number;
  readonly now?: () => number;
  readonly nextId?: (prefix: string) => string;
  /** Cap from application settings, overriding a manifest's default. */
  readonly globalVariantMaximum?: number;
}

export interface JobQueue {
  enqueue(request: EnqueueRequest): JobGroupId;
  cancelRun(run: JobRunId): void;
  cancelGroup(group: JobGroupId): void;
  /**
   * Forgets a group entirely, cancelling anything still running.
   *
   * Distinct from cancelling: a *finished* group has nothing to cancel, so a discard that only
   * cancelled left the group in the snapshot and the picker showing it. The generated files are
   * deliberately left on disk — the spec's rule that nothing is destroyed.
   */
  dismissGroup(group: JobGroupId): void;
  getSnapshot(): QueueSnapshot;
  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void;
  /** Resolves when every enqueued run has settled. For tests and for a clean shutdown. */
  drain(): Promise<void>;
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const nextId =
    options.nextId ??
    ((prefix: string) => {
      counter += 1;
      return `${prefix}_${String(counter).padStart(4, '0')}`;
    });

  const groups = new Map<string, JobGroup>();
  const runs = new Map<string, JobRun>();
  const controllers = new Map<string, AbortController>();
  const inFlight = new Set<Promise<void>>();
  const listeners = new Set<(snapshot: QueueSnapshot) => void>();

  function snapshot(): QueueSnapshot {
    const runList = [...runs.values()];
    return {
      groups: [...groups.values()],
      runs: runList,
      activeCount: runList.filter(
        (run) => run.status !== 'complete' && run.status !== 'failed' && run.status !== 'cancelled',
      ).length,
    };
  }

  function publish(): void {
    const current = snapshot();
    for (const listener of [...listeners]) listener(current);
  }

  function updateRun(id: JobRunId, patch: Partial<JobRun>): void {
    const existing = runs.get(id);
    if (existing === undefined) return;
    runs.set(id, { ...existing, ...patch });
    recomputeGroup(existing.group);
    publish();
  }

  /**
   * Derives a group's status from its runs.
   *
   * `partial` is a first-class outcome, not an error: with three variants requested, two succeeding and one
   * failing still gives the user something to choose from. Reporting that as `failed` would hide two usable
   * results.
   */
  function recomputeGroup(groupId: JobGroupId): void {
    const group = groups.get(groupId);
    if (group === undefined) return;

    const members = group.runs.map((id) => runs.get(id)).filter((run): run is JobRun => run !== undefined);
    const complete = members.filter((run) => run.status === 'complete').length;
    const failed = members.filter((run) => run.status === 'failed').length;
    const cancelled = members.filter((run) => run.status === 'cancelled').length;
    const settled = complete + failed + cancelled;

    let status: GroupStatus;
    if (settled < members.length) {
      status = members.some((run) => run.status !== 'queued') ? 'running' : 'queued';
    } else if (complete === members.length) {
      status = 'complete';
    } else if (complete > 0) {
      status = 'partial';
    } else if (cancelled > 0 && failed === 0) {
      status = 'cancelled';
    } else {
      status = 'failed';
    }

    groups.set(groupId, { ...group, status });
  }

  async function executeRun(run: JobRun, manifest: GeneratorManifest, group: JobGroup): Promise<void> {
    const controller = new AbortController();
    controllers.set(run.id, controller);

    try {
      updateRun(run.id, { status: 'waiting-for-gpu' });

      await withGpu(
        options.gpu,
        'generator',
        group.label,
        async () => {
          if (controller.signal.aborted) {
            updateRun(run.id, { status: 'cancelled', finishedAt: now() });
            return;
          }

          updateRun(run.id, { status: 'running', startedAt: now(), progress: 0 });

          const patched = options.patcher.patch(manifest, group.params, run.seeds);
          const submitted = await options.backend.submit({
            graph: patched.graph,
            assets: patched.assets.map((asset) => ({
              key: asset.key,
              path: asset.path as never,
              transport: asset.transport,
            })),
          });

          if (!submitted.ok) {
            updateRun(run.id, {
              status: 'failed',
              error: describeBackendError(submitted.error),
              finishedAt: now(),
            });
            return;
          }

          const backendJob = submitted.value;

          try {
            for await (const event of options.backend.progress(backendJob)) {
              if (controller.signal.aborted) break;
              updateRun(run.id, {
                ...(event.fraction !== undefined ? { progress: event.fraction } : {}),
                ...(event.stage !== undefined ? { stage: event.stage } : {}),
              });
            }
          } catch (error) {
            // A progress stream that dies is not fatal on its own — the job may still have produced
            // output — so collection is still attempted rather than failing here.
            updateRun(run.id, { stage: error instanceof Error ? error.message : 'progress lost' });
          }

          if (controller.signal.aborted) {
            await options.backend.cancel(backendJob);
            updateRun(run.id, { status: 'cancelled', finishedAt: now() });
            return;
          }

          const collected = await options.backend.collect(backendJob);
          if (!collected.ok) {
            updateRun(run.id, {
              status: 'failed',
              error: describeBackendError(collected.error),
              finishedAt: now(),
            });
            return;
          }

          updateRun(run.id, {
            status: 'complete',
            progress: 1,
            outputs: collected.value,
            finishedAt: now(),
          });
        },
        controller.signal,
      );
    } catch (error) {
      // Includes a cancelled GPU wait. A run that never got a turn is cancelled, not failed — the
      // distinction matters because failed runs are worth reporting and cancelled ones are not.
      const cancelled = controller.signal.aborted;
      updateRun(run.id, {
        status: cancelled ? 'cancelled' : 'failed',
        ...(cancelled ? {} : { error: error instanceof Error ? error.message : String(error) }),
        finishedAt: now(),
      });
    } finally {
      controllers.delete(run.id);
    }
  }

  return {
    enqueue(request: EnqueueRequest): JobGroupId {
      const plan: VariantPlan = planVariants({
        manifest: request.manifest,
        nextSeed: options.nextSeed,
        ...(request.variantCount !== undefined ? { requested: request.variantCount } : {}),
        ...(request.lockedSeed !== undefined ? { lockedSeed: request.lockedSeed } : {}),
        ...(options.globalVariantMaximum !== undefined
          ? { globalMaximum: options.globalVariantMaximum }
          : {}),
      });

      const groupId = jobGroupId(nextId('group'));
      const runIds: JobRunId[] = [];

      for (const batch of plan.batches) {
        const id = jobRunId(nextId('run'));
        runIds.push(id);
        runs.set(id, {
          id,
          group: groupId,
          // The first seed identifies the run in the UI; batched runs carry the rest in `seeds`.
          seed: batch.seeds[0] ?? 0,
          seeds: batch.seeds,
          status: 'queued',
          outputs: [],
        });
      }

      const group: JobGroup = {
        id: groupId,
        generator: request.manifest.id,
        ...(request.preset !== undefined ? { preset: request.preset } : {}),
        label: request.manifest.name,
        params: request.params,
        variantCount: plan.totalVariants,
        target: request.target,
        status: 'queued',
        runs: runIds,
        ...(plan.constraint !== undefined ? { constraintNote: describeConstraintNote(plan) } : {}),
        createdAt: now(),
      };
      groups.set(groupId, group);
      publish();

      for (const id of runIds) {
        const run = runs.get(id);
        if (run === undefined) continue;
        const promise = executeRun(run, request.manifest, group).finally(() => {
          inFlight.delete(promise);
        });
        inFlight.add(promise);
      }

      return groupId;
    },

    cancelRun(run: JobRunId): void {
      const controller = controllers.get(run);
      if (controller !== undefined) {
        controller.abort();
        return;
      }
      // Not started yet: mark it directly, so a queued run cancels without waiting for a turn it will
      // never take.
      const existing = runs.get(run);
      if (existing !== undefined && existing.status === 'queued') {
        updateRun(run, { status: 'cancelled', finishedAt: now() });
      }
    },

    cancelGroup(group: JobGroupId): void {
      const record = groups.get(group);
      if (record === undefined) return;
      for (const id of record.runs) this.cancelRun(id);
    },

    dismissGroup(group: JobGroupId): void {
      const record = groups.get(group);
      if (record === undefined) return;

      // Cancelled first: dismissing a group that is still working would leave its runs holding the GPU
      // for a result nobody is going to look at.
      for (const id of record.runs) this.cancelRun(id);

      // Then forgotten. Cancelling alone leaves the group in the snapshot, so the picker keeps showing
      // it and "Discard" appears to do nothing — which is exactly what it did.
      for (const id of record.runs) runs.delete(id);
      groups.delete(group);
      publish();
    },

    getSnapshot: snapshot,

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async drain(): Promise<void> {
      // Looped because a run can enqueue nothing new today, but draining a set that grows while awaited is
      // the kind of thing that silently breaks when it later can.
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },
  };
}

function describeConstraintNote(plan: VariantPlan): string {
  const constraint = plan.constraint;
  if (constraint === undefined) return '';
  switch (constraint.kind) {
    case 'no-seed-parameter':
      return '1 variant — this generator has no seed parameter';
    case 'seed-locked':
      return '1 variant — the seed is locked';
    case 'above-maximum':
      return `${plan.totalVariants} variants — limited to ${constraint.maximum}`;
    default:
      return '';
  }
}

/** Runs of a group, in creation order. */
export function runsOf(snapshot: QueueSnapshot, group: JobGroupId): readonly JobRun[] {
  return snapshot.runs.filter((run) => run.group === group);
}

/**
 * Runs that produced something, whether or not their siblings finished.
 *
 * The spec requires partial results to be usable immediately rather than after all N complete.
 */
export function completedRuns(snapshot: QueueSnapshot, group: JobGroupId): readonly JobRun[] {
  return runsOf(snapshot, group).filter((run) => run.status === 'complete');
}

/** Overall progress of a group, for one bar covering all its variants. */
export function groupProgress(snapshot: QueueSnapshot, group: JobGroupId): number {
  const members = runsOf(snapshot, group);
  if (members.length === 0) return 0;
  const total = members.reduce((sum, run) => {
    if (run.status === 'complete') return sum + 1;
    if (run.status === 'failed' || run.status === 'cancelled') return sum + 1;
    return sum + (run.progress ?? 0);
  }, 0);
  return total / members.length;
}
