// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecentProject } from '../main/ipc-contract.js';
import { RecentProjects } from './RecentProjects.js';

afterEach(() => {
  cleanup();
  delete (globalThis as { nos?: unknown }).nos;
});

/**
 * Getting back into a project.
 *
 * A project is a folder, so the only way in was the system's picker — every launch, and every switch
 * between two projects being cut the same week, began by navigating a dialog to a place the shell
 * already knew. It has remembered the last one since it learned to reopen; it never remembered more
 * than one, and never showed what it had.
 */

function withRecent(recent: readonly RecentProject[]) {
  (globalThis as { nos?: unknown }).nos = { recentProjects: () => Promise.resolve(recent) };
}

const project = (name: string, available = true): RecentProject => ({
  root: `/work/${name}`,
  name,
  available,
});

describe('reopening a project', () => {
  it('still offers the picker, which is the way in that always works', () => {
    withRecent([]);
    const onOpen = vi.fn();
    render(<RecentProjects onOpen={onOpen} onOpenPath={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Open project' })).toBeDefined();
  });

  it('shows no history control on a first run', async () => {
    // Hidden, not disabled. A disabled control says "there is something here you cannot have"; on a
    // first run there is genuinely nothing, and an empty menu beside the picker is furniture.
    withRecent([]);
    render(<RecentProjects onOpen={vi.fn()} onOpenPath={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open project' })).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Recent projects' })).toBeNull();
  });

  it('lists what was opened before, newest first', async () => {
    withRecent([project('breakdown_v3'), project('promo_cut')]);
    render(<RecentProjects onOpen={vi.fn()} onOpenPath={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Recent projects' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['breakdown_v3', 'promo_cut']);
  });

  it('opens one by path, skipping the picker entirely', async () => {
    const onOpenPath = vi.fn();
    withRecent([project('breakdown_v3')]);
    render(<RecentProjects onOpen={vi.fn()} onOpenPath={onOpenPath} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Recent projects' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /breakdown_v3/ }));

    expect(onOpenPath).toHaveBeenCalledWith('/work/breakdown_v3');
  });

  it('shows a moved folder rather than dropping it, and refuses to open it', async () => {
    // A row vanishing on its own is indistinguishable from the application having forgotten it, and
    // the user is left wondering which. Shown and unavailable is an answer; absent is a mystery.
    const onOpenPath = vi.fn();
    withRecent([project('gone_away', false)]);
    render(<RecentProjects onOpen={vi.fn()} onOpenPath={onOpenPath} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Recent projects' }));
    const row = await screen.findByRole('menuitem', { name: /gone_away/ });
    expect(row.textContent).toContain('missing');

    await userEvent.click(row);
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it('works with no bridge at all, which is every non-Electron build', () => {
    render(<RecentProjects onOpen={vi.fn()} onOpenPath={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open project' })).toBeDefined();
  });
});
