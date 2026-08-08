import { describe, expect, it } from 'vitest';
import type { ShortcutGroup } from './shortcuts.js';
import { allShortcuts, conflictingShortcuts, shortcutFor } from './shortcuts.js';

const groups: readonly ShortcutGroup[] = [
  {
    title: 'Editing',
    shortcuts: [
      { keys: ['S'], action: 'Split', command: 'split' },
      { keys: ['Ctrl', 'Shift', 'C'], action: 'Copy the look', command: 'copy-attributes' },
    ],
  },
  { title: 'Pointer', shortcuts: [{ keys: ['Alt', 'Drag'], action: 'Slip a clip' }] },
];

describe('the chord a menu prints', () => {
  it('joins the parts the way a menu spells them', () => {
    expect(shortcutFor(groups, 'copy-attributes')).toBe('Ctrl+Shift+C');
  });

  it('is nothing for a command with no binding', () => {
    // Rendered as no shortcut rather than as an empty one.
    expect(shortcutFor(groups, 'rename-clip')).toBeUndefined();
  });
});

describe('every binding', () => {
  it('is flattened in the order the groups declare', () => {
    expect(allShortcuts(groups).map((entry) => entry.action)).toEqual([
      'Split',
      'Copy the look',
      'Slip a clip',
    ]);
  });
});

describe('conflicts', () => {
  it('finds two actions claiming one chord', () => {
    // The one property of a keymap worth asserting: which action wins depends on listener order, so
    // the symptom is "that shortcut does nothing" appearing long after the collision was introduced.
    const clashing: readonly ShortcutGroup[] = [
      { title: 'A', shortcuts: [{ keys: ['Ctrl', 'D'], action: 'Duplicate' }] },
      { title: 'B', shortcuts: [{ keys: ['Ctrl', 'D'], action: 'Detach audio' }] },
    ];
    expect(conflictingShortcuts(clashing).get('ctrl+d')).toEqual(['Duplicate', 'Detach audio']);
  });

  it('ignores case, because a keymap does', () => {
    const clashing: readonly ShortcutGroup[] = [
      { title: 'A', shortcuts: [{ keys: ['s'], action: 'Split' }] },
      { title: 'B', shortcuts: [{ keys: ['S'], action: 'Something else' }] },
    ];
    expect(conflictingShortcuts(clashing).size).toBe(1);
  });

  it('is empty for a keymap that binds each chord once', () => {
    expect(conflictingShortcuts(groups).size).toBe(0);
  });
});
