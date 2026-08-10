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
        steps: [],
        jump: vi.fn(),
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

/*
 * The list, and getting back to a point several steps ago in one gesture.
 *
 * Two buttons can only ever read the top of the stack. The question after ten minutes of cutting is
 * *what did I do, and how far back is the point I want* — and the previous answer was to press
 * `Ctrl+Z` ten times and watch for the moment it looked right. Ten presses is ten chances to overshoot,
 * and overshooting is how a redo stack gets thrown away.
 */
describe('the history list', () => {
  const withSteps = (steps: HistoryControls['steps'], jump = vi.fn()) => {
    render(
      <HistoryButtons
        history={{
          canUndo: true,
          canRedo: true,
          undoLabel: 'move clip',
          redoLabel: undefined,
          steps,
          jump,
          undo: vi.fn(),
          redo: vi.fn(),
        }}
      />,
    );
    return jump;
  };

  const open = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'History' }));
  };

  it('offers nothing on a fresh document', () => {
    // One entry is the present, and a menu whose only row is "you are here" does nothing.
    withSteps([{ label: 'Open project', offset: 0 }]);
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
  });

  it('lists what has been done, newest first', async () => {
    // The step someone wants is almost always a recent one, and a list growing downwards puts it
    // further from the pointer with every edit.
    withSteps([
      { label: 'Open project', offset: -2 },
      { label: 'Split clip', offset: -1 },
      { label: 'Move clip', offset: 0 },
    ]);

    await open();
    const rows = await screen.findAllByRole('menuitem');
    expect(rows.map((row) => row.textContent?.replace('now', ''))).toEqual([
      'Move clip',
      'Split clip',
      'Open project',
    ]);
  });

  it('jumps by the offset it was given, not by a position in the list', async () => {
    // A list built one render ago names a step a commit in between may have dropped; an index into a
    // stack that has changed points at the wrong edit.
    const jump = withSteps([
      { label: 'Open project', offset: -2 },
      { label: 'Split clip', offset: -1 },
      { label: 'Move clip', offset: 0 },
    ]);

    await open();
    await userEvent.click(await screen.findByRole('menuitem', { name: /Open project/ }));
    expect(jump).toHaveBeenCalledWith(-2);
  });

  it('keeps undone steps on the list, so redo does not look dead', async () => {
    withSteps([
      { label: 'Open project', offset: -1 },
      { label: 'Split clip', offset: 0 },
      { label: 'Move clip', offset: 1 },
    ]);

    await open();
    expect(await screen.findByRole('menuitem', { name: /Move clip/ })).toBeDefined();
  });

  it('marks where the document currently is', async () => {
    withSteps([
      { label: 'Open project', offset: -1 },
      { label: 'Split clip', offset: 0 },
    ]);

    await open();
    expect((await screen.findByRole('menuitem', { name: /Split clip/ })).textContent).toContain('now');
  });
});
