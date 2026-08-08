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

    return {
      id: `run:${run.id}`,
      kind: 'generate',
      label: runLabel(group, run, snapshot),
      ...(describeRun(run) !== undefined ? { detail: describeRun(run)! } : {}),
      ...(run.progress !== undefined ? { progress: run.progress } : {}),
      state: runState(run.status),
      facts: [
        // Plural for a batched run. One seed shown for a submit that used three is the fact a user
        // would take to a bug report, and it would be wrong for two of the three files on disk.
        run.seeds.length > 1
          ? { label: 'seeds', value: run.seeds.join(', ') }
          : { label: 'seed', value: String(run.seed) },
        ...(group === undefined ? [] : paramFacts(group.params)),
      ],
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    } satisfies Activity;
  });
}

type QueueRun = QueueSnapshot['runs'][number];
type QueueGroup = QueueSnapshot['groups'][number];

/**
 * What a run is called while it is working.
 *
 * The subtlety is that a run is **not** a variant. In sequential mode it happens to be one, but a
 * batched manifest puts every seed the graph can hold into a single submit — so a group of three can
 * be one run that produces all three. Numbering that run "variant 1 of 3" was observably wrong: the
 * status bar showed it against a real Stable Audio submit, three files landed at once, and the bar
 * still implied two more runs were coming that never would.
 *
 * So the number comes from the seeds the run actually carries, not from its position in the group.
 */
function runLabel(group: QueueGroup | undefined, run: QueueRun, snapshot: QueueSnapshot): string {
  const name = group?.label ?? 'Generating';
  const total = group?.variantCount ?? 1;

  // Not numbered at all when there is nothing to distinguish — "Warehouse drone 1 of 1" is noise on
  // every single-variant run, which is every video generator by default.
  if (group === undefined || total <= 1) return name;

  const covered = Math.max(1, run.seeds.length);
  // One run holding the whole group: a count, because there is no "which one" to answer.
  if (covered >= total) return `${name} · ${total} variants`;

  const first = variantOffset(group, run, snapshot) + 1;
  if (covered === 1) return `${name} · variant ${first} of ${total}`;
  return `${name} · variants ${first}–${first + covered - 1} of ${total}`;
}

/** How many variants the runs before this one already account for. */
function variantOffset(group: QueueGroup, run: QueueRun, snapshot: QueueSnapshot): number {
  const position = group.runs.indexOf(run.id);
  if (position <= 0) return 0;

  return group.runs.slice(0, position).reduce((sum, id) => {
    const earlier = snapshot.runs.find((candidate) => candidate.id === id);
    return sum + Math.max(1, earlier?.seeds.length ?? 1);
  }, 0);
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
