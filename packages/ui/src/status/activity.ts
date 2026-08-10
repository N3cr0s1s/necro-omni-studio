/**
 * What the application is doing, as a value.
 *
 * The status bar, the job list and the progress readout are three views of one question — *what is
 * running, and how far along is it?* — and the sources are unrelated to each other: a generator queue,
 * an export, a proxy derivation, a segmentation run, a media import. Without a shared shape each of
 * those would grow its own way of saying so, and the bar would have to know about all five.
 *
 * So each source is adapted into an `Activity` at the edge, and everything downstream reads only this.
 * Adding a sixth is a mapping function and no change to any view — which is the property that matters,
 * because the list of things that take time is the list most likely to grow.
 */

export type ActivityState = 'running' | 'done' | 'failed' | 'cancelled';

/**
 * What sort of work it is.
 *
 * Used for an icon and for grouping, never for behaviour: a view that branched on the kind would be
 * the coupling this exists to avoid.
 */
export type ActivityKind = 'generate' | 'export' | 'derive' | 'segment' | 'import';

/** One labelled detail, shown when an activity is expanded. */
export interface ActivityFact {
  readonly label: string;
  readonly value: string;
}

/** One thing a user can do about an activity. The label is a verb: `Retry`, `Reveal`, `Dismiss`. */
export interface ActivityAction {
  readonly id: string;
  readonly label: string;
  run(): void;
}

export interface Activity {
  readonly id: string;
  readonly kind: ActivityKind;
  /** One line, in the user's terms: `Generating · Warehouse drone`, not `job 4a1f`. */
  readonly label: string;
  /** A second line when there is something worth adding — a stage, a failure's reason. */
  readonly detail?: string;
  /**
   * `[0, 1]`, or absent while running with nothing measurable yet.
   *
   * Absent is a real state and not a zero: a backend that has accepted a job and said nothing about it
   * is different from one that has done none of the work, and a bar sitting at 0% reads as stuck.
   */
  readonly progress?: number;
  readonly state: ActivityState;
  /** Parameters and anything else worth seeing in the expanded list. */
  readonly facts?: readonly ActivityFact[];
  /**
   * What can be done about it, offered in the expanded list.
   *
   * A failure with no way forward is a dead end: a generation that fell over on a backend hiccup
   * showed its reason and its seed and left re-entering every parameter as the only route back. The
   * list is where a user is already looking when something has gone wrong, so it is where the answer
   * belongs.
   *
   * On the activity rather than on the kind, so a later kind can offer its own — reveal a delivered
   * file, open the folder a failed import was reading — without this component learning what any of
   * them mean.
   */
  readonly actions?: readonly ActivityAction[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export function isRunning(activity: Activity): boolean {
  return activity.state === 'running';
}

/**
 * What the bar says when several things are happening at once.
 *
 * One line, because a bar with three lines is a panel. The rule is: name the single running activity
 * when there is one, and count them when there are more — a user with five jobs wants to know that
 * five are running, and opens the list when they want to know which.
 */
export interface ActivitySummary {
  readonly headline: string;
  readonly detail: string | undefined;
  /**
   * Combined progress across everything running, or absent when nothing measurable is.
   *
   * A mean rather than the minimum or the leader's. The minimum makes a bar that never moves while a
   * slow job runs beside four quick ones, and the leader's makes one that jumps backwards when it
   * finishes — both of which teach the user to stop reading it.
   */
  readonly progress: number | undefined;
  readonly runningCount: number;
  /** The most serious thing that has gone wrong and not yet been dismissed. */
  readonly failure: Activity | undefined;
}

export function summarizeActivities(activities: readonly Activity[]): ActivitySummary {
  const running = activities.filter(isRunning);
  const measured = running.filter((activity) => activity.progress !== undefined);
  const failure = activities.find((activity) => activity.state === 'failed');

  const progress =
    measured.length === 0
      ? undefined
      : measured.reduce((total, activity) => total + (activity.progress ?? 0), 0) / measured.length;

  if (running.length === 0) {
    return {
      headline: failure === undefined ? 'Idle' : failure.label,
      detail: failure?.detail,
      progress: undefined,
      runningCount: 0,
      failure,
    };
  }

  const only = running.length === 1 ? running[0] : undefined;
  return {
    headline: only?.label ?? `${running.length} tasks running`,
    // Named rather than counted when there is one, because "Exporting" with no more to say is still
    // more useful than "1 task running".
    detail: only?.detail ?? running.map((activity) => activity.label).join(' · '),
    progress,
    runningCount: running.length,
    failure,
  };
}

/**
 * Percent, as a bar should print it.
 *
 * Floored rather than rounded, so nothing reads `100%` until it is actually finished — an export that
 * says one hundred and keeps going is the readout users learn to distrust first.
 */
export function formatProgress(progress: number | undefined): string | undefined {
  if (progress === undefined) return undefined;
  return `${Math.floor(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

/**
 * How long something took, or has been going.
 *
 * Coarse on purpose: a job's duration is read to answer "is this stuck?", and a figure that changes
 * every hundredth of a second answers it worse than one that changes every second.
 */
export function formatElapsed(activity: Activity, now: number): string | undefined {
  const start = activity.startedAt;
  if (start === undefined) return undefined;

  const end = activity.finishedAt ?? now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * A message the user needs to see and may need to act on.
 *
 * Separate from an activity because it is not *work*: nothing is progressing, and it may carry a
 * decision — recovered work to restore or discard. Shown in the same bar so there is one place at the
 * bottom of the window where the application speaks, rather than a banner at the top that covers the
 * timeline and a status line at the bottom that does not.
 */
export interface StatusNotice {
  readonly id: string;
  readonly tone: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly actions?: readonly StatusAction[];
  /**
   * Clears the notice, when the caller has something to clear.
   *
   * Optional because not every notice can be dismissed: one whose source the shell does not own would
   * get a close button that did nothing, which is worse than no button at all.
   */
  readonly onDismiss?: (() => void) | undefined;
}

export interface StatusAction {
  readonly label: string;
  readonly onClick: () => void;
  /** Marks the action that does the thing, as opposed to the one that declines it. */
  readonly primary?: boolean;
}
