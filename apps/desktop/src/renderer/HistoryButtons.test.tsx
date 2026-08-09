// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HistoryControls, HistoryButtons } from './App.js';

/**
 * Undo and redo, in the title bar.
 *
 * §6.1 asks for undo and redo on *everything*, and the only visible pair used to sit inside the clip
 * actions — on one tab, and only while a clip was selected. So the control for taking back a mistake
 * disappeared exactly when the mistake was made somewhere other than a clip. The keyboard worked
 * throughout, which is what kept it invisible: everyone who tested it knew the chord.
 *
 * What these assert is the part that was missing rather than the part that worked: that the buttons
 * *say what they will take back*. The store has recorded a label for every commit since M1 and
 * `StoreSnapshot` has exposed it just as long, and nothing had ever read it.
 */

afterEach(cleanup);

function mount(overrides: Partial<HistoryControls> = {}) {
  const undo = vi.fn();
  const redo = vi.fn();
  render(
    <HistoryButtons
      history={{
        canUndo: true,
        canRedo: true,
        undoLabel: 'close the gap',
        redoLabel: 'crossfade',
        undo,
        redo,
        ...overrides,
      }}
    />,
  );
  return { undo, redo };
}

describe('what it says', () => {
  it('names the edit it would take back', () => {
    mount();
    expect(screen.getByLabelText('Undo close the gap')).toBeDefined();
    expect(screen.getByLabelText('Redo crossfade')).toBeDefined();
  });

  it('offers the shortcut too, since the chord is what a returning user reaches for', () => {
    mount();
    expect(screen.getByLabelText('Undo close the gap').getAttribute('title')).toBe(
      'Undo close the gap (Ctrl+Z)',
    );
  });

  it('says there is nothing rather than naming an edit that does not exist', () => {
    mount({ canUndo: false, undoLabel: undefined, canRedo: false, redoLabel: undefined });
    expect(screen.getByLabelText('Nothing to undo')).toBeDefined();
    expect(screen.getByLabelText('Nothing to redo')).toBeDefined();
  });

  it('disables each side on its own', () => {
    // A fresh project can be undone into and not redone out of, and the pair must not move together.
    mount({ canRedo: false, redoLabel: undefined });
    expect((screen.getByLabelText('Undo close the gap') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Nothing to redo') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('what it does', () => {
  it('undoes and redoes', async () => {
    const { undo, redo } = mount();
    await userEvent.click(screen.getByLabelText('Undo close the gap'));
    await userEvent.click(screen.getByLabelText('Redo crossfade'));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is nothing to do', async () => {
    const { undo } = mount({ canUndo: false, undoLabel: undefined });
    await userEvent.click(screen.getByLabelText('Nothing to undo'));
    expect(undo).not.toHaveBeenCalled();
  });
});
