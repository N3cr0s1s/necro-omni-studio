import { describe, expect, it } from 'vitest';
import { type Activity, formatElapsed, formatProgress, summarizeActivities } from './activity.js';

/**
 * What the status bar says.
 *
 * The rules worth pinning down are the ones a naive implementation gets wrong in ways that teach a
 * user to stop reading the bar: a progress figure that reaches 100% before the work does, a combined
 * bar that runs backwards when one of several jobs finishes, and an indeterminate job shown as 0%.
 */

const activity = (over: Partial<Activity> = {}): Activity => ({
  id: 'a',
  kind: 'generate',
  label: 'Generating',
  state: 'running',
  ...over,
});

describe('the headline', () => {
  it('names the one thing running', () => {
    expect(summarizeActivities([activity({ label: 'Warehouse drone' })]).headline).toBe('Warehouse drone');
  });

  it('counts them when there are several', () => {
    // A user with five jobs wants to know there are five; *which* five is what the list is for.
    const summary = summarizeActivities([
      activity({ id: 'a' }),
      activity({ id: 'b' }),
      activity({ id: 'c' }),
    ]);
    expect(summary.headline).toBe('3 tasks running');
    expect(summary.runningCount).toBe(3);
  });

  it('says idle when nothing is', () => {
    expect(summarizeActivities([]).headline).toBe('Idle');
    expect(summarizeActivities([activity({ state: 'done' })]).headline).toBe('Idle');
  });

  it('surfaces a failure once the work has stopped', () => {
    // Otherwise a run that failed while the user was elsewhere leaves the bar saying "Idle", which is
    // true and useless.
    const summary = summarizeActivities([
      activity({ state: 'failed', label: 'Generating', detail: 'CUDA OOM' }),
    ]);
    expect(summary.headline).toBe('Generating');
    expect(summary.detail).toBe('CUDA OOM');
    expect(summary.failure?.state).toBe('failed');
  });

  it('keeps naming what is running even when something else has failed', () => {
    const summary = summarizeActivities([
      activity({ id: 'bad', state: 'failed' }),
      activity({ id: 'good', label: 'Exporting' }),
    ]);
    expect(summary.headline).toBe('Exporting');
    expect(summary.failure).toBeDefined();
  });
});

describe('combined progress', () => {
  it('is the mean of what is measurable', () => {
    const summary = summarizeActivities([
      activity({ id: 'a', progress: 0.2 }),
      activity({ id: 'b', progress: 0.8 }),
    ]);
    expect(summary.progress).toBeCloseTo(0.5, 5);
  });

  it('ignores what has finished, so the bar does not jump backwards', () => {
    // The leader's progress would drop to the survivor's the moment the first job completed.
    const summary = summarizeActivities([
      activity({ id: 'done', state: 'done', progress: 1 }),
      activity({ id: 'slow', progress: 0.1 }),
    ]);
    expect(summary.progress).toBeCloseTo(0.1, 5);
  });

  it('ignores a running job with nothing to report rather than counting it as zero', () => {
    // A job the backend has accepted and said nothing about is not a job that has done none of the
    // work, and averaging in a zero makes a bar that sits still while the other one moves.
    const summary = summarizeActivities([activity({ id: 'a', progress: 0.6 }), activity({ id: 'b' })]);
    expect(summary.progress).toBeCloseTo(0.6, 5);
  });

  it('is absent when nothing measurable is running', () => {
    expect(summarizeActivities([activity({})]).progress).toBeUndefined();
    expect(summarizeActivities([]).progress).toBeUndefined();
  });
});

describe('printing a percentage', () => {
  it('floors, so nothing reads 100% before it is finished', () => {
    // The readout users learn to distrust first is the one that says one hundred and keeps going.
    expect(formatProgress(0.999)).toBe('99%');
    expect(formatProgress(1)).toBe('100%');
  });

  it('clamps a figure outside the range rather than printing it', () => {
    expect(formatProgress(-0.5)).toBe('0%');
    expect(formatProgress(4)).toBe('100%');
  });

  it('is nothing at all for an unmeasured task', () => {
    expect(formatProgress(undefined)).toBeUndefined();
  });
});

describe('elapsed time', () => {
  it('counts up while running', () => {
    expect(formatElapsed(activity({ startedAt: 1_000 }), 43_000)).toBe('42s');
  });

  it('stops at the finish rather than at now', () => {
    const finished = activity({ state: 'done', startedAt: 1_000, finishedAt: 11_000 });
    expect(formatElapsed(finished, 900_000)).toBe('10s');
  });

  it('reads as minutes and seconds past a minute', () => {
    expect(formatElapsed(activity({ startedAt: 0 }), 95_000)).toBe('1m 35s');
    expect(formatElapsed(activity({ startedAt: 0 }), 3_605_000)).toBe('60m 05s');
  });

  it('is nothing for something that has not started', () => {
    expect(formatElapsed(activity({}), 1000)).toBeUndefined();
  });
});
