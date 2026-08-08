// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScissorsIcon } from 'lucide-react';
import { ActionMenu } from './ActionMenu.js';

/**
 * The right-click menu.
 *
 * What is worth asserting here is only what this file decides: that a list of items becomes a menu,
 * that a disabled item cannot be chosen, and that no menu appears when there is nothing to do.
 * Positioning, edge flipping, Escape and focus return are Base UI's, and testing them here would be
 * testing the library.
 */

afterEach(cleanup);

const items = [
  { id: 'cut', label: 'Cut', icon: ScissorsIcon, shortcut: 'Ctrl+X' },
  { id: 'delete', label: 'Delete', separated: true, danger: true },
  { id: 'paste', label: 'Paste', disabled: true },
] as const;

async function openMenu(): Promise<void> {
  await userEvent.pointer({ target: screen.getByTestId('row'), keys: '[MouseRight]' });
}

function renderMenu(onChoose = vi.fn(), list: readonly (typeof items)[number][] = items) {
  render(
    <ActionMenu items={list} onChoose={onChoose}>
      <div data-testid="row">a clip</div>
    </ActionMenu>,
  );
  return onChoose;
}

describe('opening', () => {
  it('opens on a right-click of the thing it belongs to', async () => {
    renderMenu();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /Cut/ })).toBeDefined();
  });

  it('does not wrap the row in anything, so adding a menu cannot move it', () => {
    // Base UI's `render` prop makes the row itself the trigger. A wrapper would change the row's place
    // in a track lane, where position is computed per frame.
    renderMenu();
    const row = screen.getByTestId('row');
    expect(row.getAttribute('data-slot')).toBe('context-menu-trigger');
  });

  it('shows nothing at all when there is nothing to do', async () => {
    renderMenu(vi.fn(), []);
    await openMenu();
    expect(screen.queryByRole('menuitem')).toBeNull();
  });
});

describe('choosing', () => {
  it('reports the item by id, not by its label', async () => {
    // The label is prose and will be reworded; the id is the contract with the caller's reducer.
    const onChoose = renderMenu();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Cut/ }));
    expect(onChoose).toHaveBeenCalledWith('cut');
  });

  it('cannot choose a disabled item', async () => {
    const onChoose = renderMenu();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Paste' }));
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe('reading it', () => {
  it('teaches the shortcut rather than competing with it', async () => {
    renderMenu();
    await openMenu();
    expect(screen.getByText('Ctrl+X')).toBeDefined();
  });

  it('marks a destructive item, because undo is a worse answer than not doing it', async () => {
    renderMenu();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: 'Delete' }).getAttribute('data-variant')).toBe('destructive');
  });
});
