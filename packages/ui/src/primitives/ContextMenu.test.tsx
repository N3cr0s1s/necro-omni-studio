// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, placeMenu } from './ContextMenu.js';

/**
 * The menu a right-click opens.
 *
 * Deliberately dumb, so what is tested is only what it owns: dismissal, choosing, and staying on
 * screen. What the items *are* is the caller's, and tested there.
 */

afterEach(cleanup);

const items = [
  { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C' },
  { id: 'paste', label: 'Paste', disabled: true },
  { id: 'remove', label: 'Delete', danger: true, separated: true },
];

function renderMenu(overrides: Partial<Parameters<typeof ContextMenu>[0]> = {}) {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  render(<ContextMenu x={10} y={10} items={items} onChoose={onChoose} onClose={onClose} {...overrides} />);
  return { onChoose, onClose };
}

describe('choosing', () => {
  it('reports what was chosen', () => {
    const { onChoose } = renderMenu();
    screen.getByText('Copy').click();
    expect(onChoose).toHaveBeenCalledWith('copy');
  });

  it('closes afterwards, since the decision is made', () => {
    const { onClose } = renderMenu();
    screen.getByText('Copy').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('does not report a disabled item', () => {
    const { onChoose } = renderMenu();
    screen.getByText('Paste').click();
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe('dismissal', () => {
  it('closes on a click outside', () => {
    // A menu that could only be dismissed by choosing something would make a mis-click into a forced
    // decision.
    const { onClose } = renderMenu();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open for a click inside', () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(screen.getByRole('menu'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on escape', () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('teaching the shortcut', () => {
  it('shows it beside the action', () => {
    renderMenu();
    expect(screen.getByText('Ctrl+C')).toBeDefined();
  });
});

describe('staying on screen', () => {
  const viewport = { width: 1000, height: 800 };

  it('opens at the pointer when there is room', () => {
    expect(placeMenu(100, 100, 5, viewport)).toEqual({ left: 100, top: 100 });
  });

  it('flips left rather than hanging off the right edge', () => {
    expect(placeMenu(900, 100, 5, viewport).left).toBeLessThan(900);
  });

  it('flips up rather than covering the thing that was clicked', () => {
    // A menu pinned to the bottom edge covers the one place the user is still looking.
    expect(placeMenu(100, 780, 8, viewport).top).toBeLessThan(780);
  });

  it('never opens off the top or left', () => {
    const placed = placeMenu(5, 5, 40, viewport);
    expect(placed.left).toBeGreaterThanOrEqual(0);
    expect(placed.top).toBeGreaterThanOrEqual(0);
  });
});
