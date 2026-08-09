// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTabs, type WorkspaceTabView } from './WorkspaceTabs.js';

/**
 * The window's tab bar, per issues #31 and #30.
 *
 * The bar knows almost nothing: an id, a title, and whether a tab closes. What a kind *is* stays with
 * the caller, which is what makes a new kind an entry rather than an edit here.
 */

afterEach(cleanup);

const tabs: readonly WorkspaceTabView[] = [
  { id: 'editor', title: 'Editor', closable: false },
  { id: 'effect:film_grain', title: 'Film grain', closable: true },
];

const renderBar = (overrides: Partial<Parameters<typeof WorkspaceTabs>[0]> = {}) =>
  render(<WorkspaceTabs tabs={tabs} active="editor" onSelect={vi.fn()} {...overrides} />);

describe('the bar', () => {
  it('draws a tab for each', () => {
    renderBar();
    expect(screen.getByRole('tab', { name: 'Editor' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Film grain' })).toBeDefined();
  });

  it('says which is showing', () => {
    renderBar({ active: 'effect:film_grain' });
    expect(screen.getByRole('tab', { name: 'Film grain' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Editor' }).getAttribute('aria-selected')).toBe('false');
  });

  it('is a tablist, so it is one stop rather than N', () => {
    renderBar();
    expect(screen.getByRole('tablist', { name: 'Workspace' })).toBeDefined();
  });
});

describe('choosing one', () => {
  it('reports the id', async () => {
    const onSelect = vi.fn();
    renderBar({ onSelect });
    await userEvent.click(screen.getByRole('tab', { name: 'Film grain' }));
    expect(onSelect).toHaveBeenCalledWith('effect:film_grain');
  });
});

describe('closing one', () => {
  it('is offered on a tab that closes', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'Close Film grain' })).toBeDefined();
  });

  it('is not offered on one that does not', () => {
    // The editor is the application; a close control for it is a gesture with no good answer.
    renderBar();
    expect(screen.queryByRole('button', { name: 'Close Editor' })).toBeNull();
  });

  it('reports the id, and not as a selection', async () => {
    // The close control sits inside the tab, so a click that also selected it would move the user to
    // the tab they just asked to be rid of.
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderBar({ onSelect, onClose });

    await userEvent.click(screen.getByRole('button', { name: 'Close Film grain' }));

    expect(onClose).toHaveBeenCalledWith('effect:film_grain');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('is always there, not only on hover', () => {
    // A control that appears on hover cannot be found by anyone who does not already know it exists,
    // and it shifts the layout when it arrives.
    renderBar();
    const close = screen.getByRole('button', { name: 'Close Film grain' });
    expect(close.className).not.toMatch(/opacity-0|hidden|invisible/);
  });
});

describe('the rest of the line', () => {
  it('carries the window’s own controls', () => {
    // #30 asks for the bar to span the full width; trailing controls are what fills it rather than
    // empty space.
    renderBar({ children: <button type="button">Save</button> });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
  });
});
