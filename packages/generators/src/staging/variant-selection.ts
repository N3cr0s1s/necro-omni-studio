import type { JobGroupId, JobRunId } from '@nos/core';
import type { BackendOutput } from '../contracts/backend.js';
import type { GeneratorManifest, OutputDescriptor } from '../contracts/manifest.js';
import type { JobGroup, JobRun, JobTarget, RunStatus } from '../queue/job-queue.js';

/**
 * In-place variant selection.
 *
 * The spec is emphatic that this is **not** a modal chooser: a music bed or a cutaway can only be judged
 * where it will live, so the candidates are auditioned on the timeline at the target position and one is
 * confirmed there. Two consequences shape this model:
 *
 * - **Partial results are usable immediately.** A finished run is auditionable while its siblings are
 *   still generating, so stepping walks the ready candidates and reports the rest as still coming.
 * - **Nothing is destroyed by choosing.** Confirming produces an *outcome* describing what to insert;
 *   the unaccepted variants stay in `generated/`. This module never deletes a file.
 *
 * It is pure: no queue, no store, no clock. The picker renders it and the editing layer applies its
 * outcome, which is what lets the whole interaction be tested without a backend.
 */

export interface VariantCandidate {
  readonly run: JobRunId;
  /** 1-based, for the `2 / 3` readout. Stable across a group's lifetime. */
  readonly ordinal: number;
  readonly seed: number;
  readonly status: RunStatus;
  /** Complete **and** carrying an output. A complete run with no file cannot be auditioned. */
  readonly ready: boolean;
  readonly output?: BackendOutput;
  readonly progress?: number;
  readonly stage?: string;
  readonly error?: string;
}

export interface VariantSelection {
  readonly group: JobGroupId;
  readonly label: string;
  readonly target: JobTarget;
  readonly candidates: readonly VariantCandidate[];
  /** The candidate being auditioned, if any is ready yet. */
  readonly current?: VariantCandidate;
  readonly readyCount: number;
  readonly totalCount: number;
  /** True while any run could still produce a candidate. */
  readonly pending: boolean;
  /** Every run finished and none produced an output. */
  readonly exhausted: boolean;
}

export interface SelectionRequest {
  readonly group: JobGroup;
  /** The group's runs, in any order — ordinals come from the group's own run list. */
  readonly runs: readonly JobRun[];
  readonly manifest: GeneratorManifest;
  /** Kept selected if it is still ready; otherwise the first ready candidate is chosen. */
  readonly current?: JobRunId;
}

/**
 * Builds the selection model for a group.
 *
 * The selected candidate is *derived* rather than stored: a run can fail after being selected, and a model
 * that remembered a dead run would leave the picker showing a variant that no longer exists.
 */
export function buildSelection(request: SelectionRequest): VariantSelection {
  const { group, manifest } = request;
  const byId = new Map(request.runs.map((run) => [run.id, run]));

  const candidates: VariantCandidate[] = [];
  group.runs.forEach((runId, index) => {
    const run = byId.get(runId);
    if (run === undefined) return;
    candidates.push(toCandidate(run, index + 1, manifest));
  });

  const ready = candidates.filter((candidate) => candidate.ready);
  const kept = ready.find((candidate) => candidate.run === request.current);
  const current = kept ?? ready[0];

  return {
    group: group.id,
    label: group.label,
    target: group.target,
    candidates,
    ...(current !== undefined ? { current } : {}),
    readyCount: ready.length,
    totalCount: candidates.length,
    pending: candidates.some((candidate) => isPending(candidate.status)),
    exhausted:
      candidates.length > 0 &&
      ready.length === 0 &&
      !candidates.some((candidate) => isPending(candidate.status)),
  };
}

function isPending(status: RunStatus): boolean {
  return status === 'queued' || status === 'waiting-for-gpu' || status === 'running';
}

function toCandidate(run: JobRun, ordinal: number, manifest: GeneratorManifest): VariantCandidate {
  const output = primaryOutput(run.outputs, manifest);
  return {
    run: run.id,
    ordinal,
    seed: run.seed,
    status: run.status,
    ready: run.status === 'complete' && output !== undefined,
    ...(output !== undefined ? { output } : {}),
    ...(run.progress !== undefined ? { progress: run.progress } : {}),
    ...(run.stage !== undefined ? { stage: run.stage } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

/**
 * The output a run's clip is made from.
 *
 * The manifest decides, not the backend: a graph may save a preview image beside the video it produced, and
 * inserting the preview because it happened to be listed first would be a maddening bug. The first
 * non-optional declared output wins; the backend's own guess is only a fallback for a graph whose manifest
 * declares nothing usable.
 */
export function primaryOutput(
  outputs: readonly BackendOutput[],
  manifest: GeneratorManifest,
): BackendOutput | undefined {
  if (outputs.length === 0) return undefined;

  const declared = (manifest.outputs ?? []).filter((output) => output.optional !== true);
  for (const descriptor of declared) {
    const match = outputs.find((output) => matches(output, descriptor));
    if (match !== undefined) return match;
  }
  return outputs.find((output) => output.type === manifest.produces) ?? outputs[0];
}

function matches(output: BackendOutput, descriptor: OutputDescriptor): boolean {
  // The queue keys outputs by graph node, which is what the manifest's `node` names. Falling back to the
  // descriptor key keeps a backend that keys them differently working.
  return output.key === descriptor.node || output.key === descriptor.key;
}

/**
 * Steps to another ready candidate.
 *
 * Wraps, and walks **only** ready candidates: stepping onto a variant that is still generating would show
 * an empty frame and make the control feel broken half the time. Returns the same selection when there is
 * nothing else to step to, so a caller can compare identity to know whether anything changed.
 */
export function stepSelection(selection: VariantSelection, delta: number): VariantSelection {
  const ready = selection.candidates.filter((candidate) => candidate.ready);
  if (ready.length === 0) return selection;

  const currentIndex = ready.findIndex((candidate) => candidate.run === selection.current?.run);
  const steps = Math.trunc(delta);
  const nextIndex = (((currentIndex + steps) % ready.length) + ready.length) % ready.length;
  const next = ready[nextIndex];
  if (next === undefined || next.run === selection.current?.run) return selection;

  return { ...selection, current: next };
}

/** Selects a specific run, ignoring one that is not ready. */
export function selectCandidate(selection: VariantSelection, run: JobRunId): VariantSelection {
  const candidate = selection.candidates.find((entry) => entry.run === run && entry.ready);
  if (candidate === undefined || candidate.run === selection.current?.run) return selection;
  return { ...selection, current: candidate };
}

/**
 * What confirming or dismissing a selection means.
 *
 * A description, not an action. The staging layer has no business mutating the document, and returning a
 * value instead keeps the whole interaction testable and undoable as one patch.
 */
export type SelectionOutcome =
  | {
      readonly kind: 'accept';
      readonly group: JobGroupId;
      readonly run: JobRunId;
      readonly output: BackendOutput;
      readonly seed: number;
      readonly target: JobTarget;
    }
  | { readonly kind: 'discard'; readonly group: JobGroupId };

/** Confirms the current candidate. `undefined` when nothing is ready — the picker disables the control. */
export function acceptSelection(selection: VariantSelection): SelectionOutcome | undefined {
  const current = selection.current;
  if (current?.output === undefined) return undefined;
  return {
    kind: 'accept',
    group: selection.group,
    run: current.run,
    output: current.output,
    seed: current.seed,
    target: selection.target,
  };
}

/** Dismisses the group. The generated files are deliberately left where they are. */
export function discardSelection(selection: VariantSelection): SelectionOutcome {
  return { kind: 'discard', group: selection.group };
}

/**
 * One line describing the selection's state, as the picker shows it.
 *
 * Written as a function so the wording is asserted once rather than in every surface that displays it.
 */
export function describeSelection(selection: VariantSelection): string {
  if (selection.totalCount === 0) return 'no variants';
  if (selection.exhausted) return 'every variant failed';
  if (selection.current === undefined) {
    return selection.pending ? `generating ${selection.totalCount} variants` : 'no variant is ready';
  }

  const position = `${selection.current.ordinal} / ${selection.totalCount}`;
  if (!selection.pending) return position;
  return `${position} · ${selection.totalCount - selection.readyCount} still generating`;
}
