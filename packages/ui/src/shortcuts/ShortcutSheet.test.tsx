// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShortcutGroup } from './shortcuts.js';
import { ShortcutSheet } from './ShortcutSheet.js';

afterEach(cleanup);

const groups: readonly ShortcutGroup[] = [
  {
    title: 'Editing',
    shortcuts: [
      { keys: ['S'], action: 'Split at the playhead', note: 'the selected clip' },
      { keys: ['Ctrl', 'Shift', 'C'], action: 'Copy the look' },
    ],
  },
  {
    title: 'Pointer',
    shortcuts: [{ keys: ['Alt', 'Drag'], action: 'Slip a clip', note: 'the content moves' }],
  },
];

const sheet = (open = true) => render(<ShortcutSheet groups={groups} open={open} onOpenChange={vi.fn()} />);

describe('the reference', () => {
  it('names every group', () => {
    sheet();
    expect(screen.getByText('Editing')).toBeTruthy();
    expect(screen.getByText('Pointer')).toBeTruthy();
  });

  it('draws each part of a chord as its own key', () => {
    // A `+` inside a label is a character on a keycap, so `Ctrl+Shift+C` in one box reads as a key
    // called "Ctrl+Shift+C".
    sheet();
    for (const key of ['Ctrl', 'Shift', 'C']) {
      expect(screen.getByText(key), key).toBeTruthy();
    }
  });

  it('carries the note that says when a binding applies', () => {
    // The pointer gestures need it most: `Drag` means two different things depending on where.
    sheet();
    expect(screen.getByText('the content moves')).toBeTruthy();
  });

  it('documents the gesture nothing else can reach', () => {
    // The reason the sheet exists. `Alt`-drag is the spec's slip and has no affordance on screen.
    sheet();
    expect(screen.getByText('Slip a clip')).toBeTruthy();
  });

  it('shows nothing while closed', () => {
    sheet(false);
    expect(screen.queryByText('Split at the playhead')).toBeNull();
  });
});
