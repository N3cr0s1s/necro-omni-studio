import type { Activity, ActivityFact } from '@nos/ui';
import type { QueueSnapshot } from '@nos/generators';
import type { ExportProgress } from '@nos/export';

/**
 * Turning what the application is doing into what the status bar shows.
 *
 * One adapter per source, and nothing shared between them but the shape they produce. The bar, the
 * task list and the progress readout then know about `Activity` and about nothing else — so a sixth
 * source of background work is a function here and no change to any view.
 *
 * Kept out of the components deliberately: deciding that a queued run with no progress yet is
 * "waiting for the backend" rather than "0%" is a judgement about the *domain*, and it belongs where
 * it can be tested without rendering anything.
 */

/**
 * The generator queue.
 *
 * One activity per **run**, not per group. A group of three variants is three things the backend is
 * doing, they finish at different times, and collapsing them would hide exactly the partial progress
 * the spec's §5.8 is built around — the point of variants is that the first ready one is usable.
 */
export function generatorActivities(snapshot: QueueSnapshot): readonly Activity[] {
  return snapshot.runs.map((run) => {
    const group = snapshot.groups.find((candidate) => candidate.id === run.group);
    const ordinal = group === undefined ? 0 : group.runs.indexOf(run.id) + 1;
    const variants = group?.variantCount ?? 1;

    return {
      id: `run:${run.id}`,
      kind: 'generate',
      // Named for what it makes, and numbered only when there is more than one — "Warehouse drone 1
      // of 1" is noise on every single-variant run, which is every video generator by default.
      label:
        variants > 1
          ? `${group?.label ?? 'Generating'} · variant ${ordinal} of ${variants}`
          : (group?.label ?? 'Generating'),
      ...(describeRun(run) !== undefined ? { detail: describeRun(run)! } : {}),
      ...(run.progress !== undefined ? { progress: run.progress } : {}),
      state: runState(run.status),
      facts: [
        { label: 'seed', value: String(run.seed) },
        ...(group === undefined ? [] : paramFacts(group.params)),
      ],
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    } satisfies Activity;
  });
}

function runState(status: QueueSnapshot['runs'][number]['status']): Activity['state'] {
  switch (status) {
    case 'complete':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

/**
 * What a run is doing, in the user's terms.
 *
 * A failure says why. A run the backend has accepted but not reported on says *that*, rather than
 * showing nothing — the gap between submitting and the first progress event is where a user starts
 * wondering whether anything happened.
 */
function describeRun(run: QueueSnapshot['runs'][number]): string | undefined {
  if (run.error !== undefined) return run.error;
  if (run.stage !== undefined) return run.stage;
  // `waiting-for-gpu` is its own answer: the semaphore is the reason, and "waiting for the backend"
  // would blame the wrong thing for a queue the application itself is holding.
  if (run.status === 'waiting-for-gpu') return 'waiting for the GPU';
  if (run.status === 'queued') return 'queued';
  if (runState(run.status) === 'running' && run.progress === undefined) return 'waiting for the backend';
  return undefined;
}

/**
 * The parameters a run was given.
 *
 * Trimmed, because a manifest may declare twenty and a status row has one line: the long ones are
 * what identify a result — a prompt is how anyone recognises which variant is which — so they lead,
 * and the rest follow until the row is full.
 */
function paramFacts(params: Readonly<Record<string, string | number | boolean>>): readonly ActivityFact[] {
  const entries = Object.entries(params);
  const long = entries.filter(([, value]) => typeof value === 'string' && value.length > 24);
  const short = entries.filter(([, value]) => !(typeof value === 'string' && value.length > 24));

  return [...long, ...short].slice(0, 6).map(([label, value]) => ({
    label,
    value: typeof value === 'string' && value.length > 80 ? `${value.slice(0, 80)}…` : String(value),
  }));
}

/** The export, which reports its own progress in frames. */
export function exportActivity(progress: ExportProgress | undefined): readonly Activity[] {
  if (progress === undefined) return [];

  const state: Activity['state'] =
    progress.phase === 'complete'
      ? 'done'
      : progress.phase === 'failed'
        ? 'failed'
        : progress.phase === 'cancelled'
          ? 'cancelled'
          : 'running';

  return [
    {
      id: 'export',
      kind: 'export',
      label: 'Exporting',
      detail:
        progress.message ?? `${progress.framesDone} / ${progress.framesTotal} frames · ${progress.fps} fps`,
      progress: progress.fraction,
      state,
      facts: [
        { label: 'frames', value: `${progress.framesDone} / ${progress.framesTotal}` },
        { label: 'fps', value: String(progress.fps) },
      ],
    },
  ];
}

/**
 * Derivations — proxies, filmstrips, waveforms.
 *
 * Counted rather than listed. A dozen files import at once and each produces three artifacts; naming
 * every one would fill the list with work nobody asked for by name. What a user wants to know is that
 * the application is still busy and roughly how much is left.
 */
export function derivationActivity(pending: number, done: number): readonly Activity[] {
  if (pending <= 0) return [];

  const total = pending + done;
  return [
    {
      id: 'derive',
      kind: 'derive',
      label: pending === 1 ? 'Preparing 1 file' : `Preparing ${pending} files`,
      detail: 'proxies, filmstrips and waveforms',
      ...(total > 0 ? { progress: done / total } : {}),
      state: 'running',
    },
  ];
}

/** Segmentation, which reports a fraction of its propagation range. */
export function segmentationActivity(
  running: boolean,
  progress: number | undefined,
  error: string | undefined,
): readonly Activity[] {
  if (!running && error === undefined) return [];

  return [
    {
      id: 'segment',
      kind: 'segment',
      label: 'Segmenting',
      ...(error !== undefined ? { detail: error } : {}),
      ...(progress !== undefined ? { progress } : {}),
      state: error !== undefined ? 'failed' : 'running',
    },
  ];
}

/**
 * Everything, in the order a reader wants it.
 *
 * Running first and newest-first within that, because the bar names the single running activity and
 * the list is read from the top. Finished work stays — it is the only record of what a session did,
 * and the spec leaves unaccepted variants on disk precisely so they can be reconsidered.
 */
export function orderActivities(activities: readonly Activity[]): readonly Activity[] {
  const rank = (activity: Activity): number => (activity.state === 'running' ? 0 : 1);
  return [...activities].sort((a, b) => {
    const byState = rank(a) - rank(b);
    if (byState !== 0) return byState;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
}
