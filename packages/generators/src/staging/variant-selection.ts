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
  /**
   * This candidate's own identity.
   *
   * Not the run's, and that distinction is the whole reason it exists: a **batched** run is one
   * submit carrying several seeds, so three variants can share a single `run`. Selecting by run then
   * always resolves to the first of them — every chip highlights at once, stepping appears to do
   * nothing, and accepting takes the wrong file. The spec's own audio manifest is batched by default,
   * so this is the ordinary case rather than a corner.
   */
  readonly key: string;
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
  /**
   * The parameters the group was submitted with.
   *
   * Carried because the *declared* length of a generated clip is one of them: computing it from an
   * empty parameter set falls back to the manifest's default, so a user who asked for ten seconds
   * received fifty and nothing on screen explained why.
   */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly candidates: readonly VariantCandidate[];
  /** The candidate being auditioned, if any is ready yet. */
  readonly current?: VariantCandidate;
  readonly readyCount: number;
  readonly totalCount: number;
  /**
   * Variants the user asked for.
   *
   * Not always `totalCount`: a **batched** run is one submit carrying several seeds, so while it is still
   * running it contributes a single pending candidate. Reporting "1 variant" there would tell the user
   * one is coming when three are.
   */
  readonly requestedCount: number;
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
  /**
   * Kept selected if it is still ready; otherwise the first ready candidate is chosen.
   *
   * A candidate **key**, not a run id: a batched run carries several variants, and naming the run
   * would select all of them at once.
   */
  readonly current?: string;
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
  for (const runId of group.runs) {
    const run = byId.get(runId);
    if (run === undefined) continue;
    for (const candidate of candidatesOf(run, candidates.length, manifest)) candidates.push(candidate);
  }

  const ready = candidates.filter((candidate) => candidate.ready);
  const kept = ready.find((candidate) => candidate.key === request.current);
  const current = kept ?? ready[0];

  return {
    group: group.id,
    label: group.label,
    target: group.target,
    params: group.params,
    candidates,
    ...(current !== undefined ? { current } : {}),
    readyCount: ready.length,
    totalCount: candidates.length,
    requestedCount: Math.max(group.variantCount, candidates.length),
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

/**
 * The candidates one run contributes.
 *
 * Usually one — but a **batched** run is a single submit carrying several seeds, and the spec's own audio
 * manifest is batched by default. Treating a run as one candidate would show one variant where three were
 * generated, and the two extra files would sit in `generated/` with no way to reach them.
 *
 * So a completed run expands to one candidate per variant output, paired with the seed at the same index.
 * A run that has not completed contributes a single pending candidate: there is nothing to expand yet, and
 * showing three identical "generating" chips for one submit would misreport what is happening.
 */
/**
 * A candidate's identity within its group.
 *
 * The run plus its index in that run's outputs. Derived rather than generated, so the same group
 * rebuilt from the same runs produces the same keys — a selection has to survive the rebuild that
 * every progress tick causes.
 */
export function candidateKey(run: JobRunId, index: number): string {
  return `${run}#${index}`;
}

function candidatesOf(run: JobRun, offset: number, manifest: GeneratorManifest): readonly VariantCandidate[] {
  const shared = {
    run: run.id,
    status: run.status,
    ...(run.progress !== undefined ? { progress: run.progress } : {}),
    ...(run.stage !== undefined ? { stage: run.stage } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };

  const outputs = variantOutputs(run.outputs, manifest);
  if (run.status !== 'complete' || outputs.length === 0) {
    return [{ ...shared, key: candidateKey(run.id, 0), ordinal: offset + 1, seed: run.seed, ready: false }];
  }

  return outputs.map((output, index) => ({
    ...shared,
    key: candidateKey(run.id, index),
    ordinal: offset + index + 1,
    // A sequential run reports its own seed; only a batched one indexes into the submit's seed list.
    // Indexing unconditionally would report a batch's first seed for every ordinary run whose `seeds`
    // array disagreed with `seed`, and the seed is what makes a result reproducible.
    seed: run.seeds.length > 1 ? (run.seeds[index] ?? run.seed) : run.seed,
    ready: true,
    output,
  }));
}

/**
 * The outputs of a run that are variants of each other.
 *
 * A graph may save a preview beside what it produced, so this keeps only the outputs matching the
 * manifest's primary declaration — everything else is a companion file, not an alternative.
 */
function variantOutputs(
  outputs: readonly BackendOutput[],
  manifest: GeneratorManifest,
): readonly BackendOutput[] {
  const primary = primaryOutput(outputs, manifest);
  if (primary === undefined) return [];
  return outputs.filter((output) => output.key === primary.key && output.type === primary.type);
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
      /**
       * The candidate accepted, distinct from its run.
       *
       * Carried because a batched run's variants share a run id, and a caller deriving a clip id from
       * the run alone would produce the same id for all three — a collision the editing layer refuses,
       * which reads as "Keep does nothing" for every variant after the first.
       */
      readonly candidate: string;
      readonly output: BackendOutput;
      readonly seed: number;
      readonly target: JobTarget;
      /** What the group was submitted with, so the accepted clip is as long as the user asked. */
      readonly params: Readonly<Record<string, string | number | boolean>>;
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
    candidate: current.key,
    output: current.output,
    seed: current.seed,
    target: selection.target,
    params: selection.params,
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
    // The requested count, not the candidate count: a batched run in flight is one candidate carrying
    // however many variants were asked for.
    return selection.pending
      ? `generating ${selection.requestedCount} variant${selection.requestedCount === 1 ? '' : 's'}`
      : 'no variant is ready';
  }

  const position = `${selection.current.ordinal} / ${selection.totalCount}`;
  if (!selection.pending) return position;
  return `${position} · ${selection.totalCount - selection.readyCount} still generating`;
}
