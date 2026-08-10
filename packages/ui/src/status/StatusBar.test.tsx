// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from './activity.js';
import { StatusBar } from './StatusBar.js';

afterEach(cleanup);

/**
 * What a user can do about something that went wrong.
 *
 * The task list is where someone is already looking when work has failed, and until now it could only
 * describe: a generation that fell over showed its reason and its seed and offered nothing to press.
 * The action belongs on the activity rather than on the kind, so a later one — reveal a delivered
 * file, open the folder a failed import was reading — needs no change here.
 */

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 'run:r1',
    kind: 'generate',
    label: 'Generating · Warehouse drone',
    state: 'failed',
    detail: 'the backend refused',
    ...overrides,
  };
}

/**
 * The list is behind a popover, because the bar itself is one line.
 *
 * Found by its count rather than its `title`: the trigger has text, so the accessible name is
 * `1 done` — the tooltip never becomes the name while there is content to read.
 */
async function openTasks(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /\d+ (done|running)/ }));
}

describe('acting on an activity', () => {
  it('offers the action in the task list', async () => {
    const run = vi.fn();
    render(<StatusBar activities={[activity({ actions: [{ id: 'retry', label: 'Run again', run }] })]} />);

    await openTasks();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeDefined();
  });

  it('runs it when pressed, which is the whole point', async () => {
    const run = vi.fn();
    render(<StatusBar activities={[activity({ actions: [{ id: 'retry', label: 'Run again', run }] })]} />);

    await openTasks();
    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('shows the reason as well, since an action without one is a guess', async () => {
    render(
      <StatusBar activities={[activity({ actions: [{ id: 'retry', label: 'Run again', run: vi.fn() }] })]} />,
    );

    await openTasks();
    // Scoped to the list. The bar's own summary says it too, so an unscoped query matches twice —
    // which is the component being right and the assertion being loose.
    const list = screen.getByRole('dialog');
    expect(within(list).getByText('the backend refused')).toBeDefined();
    expect(within(list).getByRole('button', { name: 'Run again' })).toBeDefined();
  });

  it('adds nothing to an activity that carries no actions', async () => {
    render(<StatusBar activities={[activity()]} />);

    await openTasks();
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
  });
});
