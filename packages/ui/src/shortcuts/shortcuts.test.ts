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

/*
 * Scopes, and why the collision check needs them.
 *
 * `←` moves a keyframe, steps to the previous variant and steps the playhead. Three bindings on one
 * key and not a clash, because no two of them are listening at the same moment — and a check that
 * reported it as one would be switched off, which is the only way a check ever stops finding things.
 */
describe('scoped collisions', () => {
  const groups = (scopeB: string | undefined) => [
    { title: 'Window', shortcuts: [{ keys: ['←'], action: 'Step back one frame' }] },
    {
      title: 'Something focused',
      ...(scopeB === undefined ? {} : { scope: scopeB }),
      shortcuts: [{ keys: ['←'], action: 'Move a keyframe' }],
    },
  ];

  it('does not report a chord shared across scopes', () => {
    expect([...conflictingShortcuts(groups('keyframe')).entries()]).toEqual([]);
  });

  it('still reports one shared within a scope', () => {
    // The corollary, and the reason the scopes are per listener rather than one lumped "focus": a
    // keyframe marker and the variant picker both wanting Enter is a real clash.
    const clashing = [
      {
        title: 'Focused',
        scope: 'keyframe',
        shortcuts: [
          { keys: ['Enter'], action: 'Cycle the easing' },
          { keys: ['Enter'], action: 'Keep the variant' },
        ],
      },
    ];
    expect([...conflictingShortcuts(clashing).keys()]).toEqual(['enter']);
  });

  it('treats a group with no scope as the window, which is what most are', () => {
    expect([...conflictingShortcuts(groups(undefined)).keys()]).toEqual(['←']);
  });

  it('names the chord plainly, not the key it was bucketed under', () => {
    expect([...conflictingShortcuts(groups(undefined)).keys()]).not.toContain('window\u0000←');
  });
});
