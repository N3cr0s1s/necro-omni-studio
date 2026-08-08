import { describe, expect, it } from 'vitest';
import { conflictingShortcuts } from '@nos/ui';
import { SHORTCUT_GROUPS, shortcutLabel } from './shortcuts.js';

/**
 * The editor's own keymap.
 *
 * Two things are worth asserting about a keymap, and neither is "does this list look right".
 *
 * The first is that no chord is claimed twice. Which of two handlers wins depends on listener order,
 * so a collision does not fail — it makes one of the two actions quietly stop working, and it is
 * noticed months later as "that shortcut does nothing".
 *
 * The second is that the menus and this list agree. They used to be written out separately, so a
 * rebinding had two places to change and the menu was the one that would keep printing the old chord.
 */

/** The keyboard groups. `Pointer` is excluded on purpose — see the collision test. */
const KEY_GROUPS = SHORTCUT_GROUPS.filter((group) => group.title !== 'Pointer');

describe('the keymap', () => {
  it('binds each chord to exactly one action', () => {
    const clashes = conflictingShortcuts(KEY_GROUPS);
    expect([...clashes.entries()]).toEqual([]);
  });

  it('describes every binding with an action', () => {
    for (const group of SHORTCUT_GROUPS) {
      for (const shortcut of group.shortcuts) {
        expect(shortcut.action.length, JSON.stringify(shortcut)).toBeGreaterThan(0);
        expect(shortcut.keys.length, JSON.stringify(shortcut)).toBeGreaterThan(0);
      }
    }
  });

  it('lists the same chord twice only where the context tells them apart', () => {
    // `Drag` moves a clip from its body and trims it from its edge; a double-click renames a name and
    // adds a keyframe on a lane. Real gestures, not collisions — so each carries the note that says
    // which is which, and this asserts that rather than pretending the repetition is not there.
    const pointer = SHORTCUT_GROUPS.find((group) => group.title === 'Pointer');
    const repeated = [...conflictingShortcuts(pointer === undefined ? [] : [pointer]).keys()];
    expect(repeated).toEqual(['drag', 'double-click']);

    for (const shortcut of pointer?.shortcuts ?? []) {
      const chord = shortcut.keys.join('+').toLowerCase();
      if (repeated.includes(chord)) expect(shortcut.note, shortcut.action).toBeDefined();
    }
  });
});

describe('what a menu prints', () => {
  it('comes from the same declaration the sheet draws', () => {
    expect(shortcutLabel('copy-attributes')).toBe('Ctrl+Shift+C');
    expect(shortcutLabel('split')).toBe('S');
  });

  it('is nothing for a command nobody bound', () => {
    // A menu row renders no shortcut rather than an empty box.
    expect(shortcutLabel('rename-clip')).toBeUndefined();
  });
});
