/**
 * What the keyboard and the pointer can be asked to do.
 *
 * A contract rather than a list: *which* keys an application binds is its own business — this package
 * has no idea that `S` splits a clip — but how a binding is described, grouped and drawn is the same
 * everywhere, and it is what the reference sheet renders.
 *
 * Gestures are shortcuts too. `Alt`-drag is how the spec's *csúsztatás* is performed and there is no
 * other way to reach it; a reference that listed only key chords would leave the one binding nobody
 * can discover undocumented, which is the reason this exists at all.
 */

export interface Shortcut {
  /**
   * The chord, one element per part: `['Ctrl', 'Shift', 'C']`.
   *
   * Split rather than a single string so each part is drawn as its own key. A `+` inside a label is a
   * character on a keycap, and `Ctrl+X` in one box reads as a key called "Ctrl+X".
   */
  readonly keys: readonly string[];
  /** What it does, in the imperative: "Split at the playhead". */
  readonly action: string;
  /** When it applies, when that is not obvious — "with a clip selected". */
  readonly note?: string;
  /**
   * Ties this binding to a command elsewhere, so a menu can print the same chord.
   *
   * Optional because plenty of bindings have no menu entry. Where one does exist, this is what keeps
   * the two from drifting: a shortcut is written down once and read from wherever it is shown.
   */
  readonly command?: string;
}

/**
 * Which listener owns a group's bindings.
 *
 * `window` is the default and the common case: the key works wherever the pointer is, suppressed only
 * in a text field. Anything else names a focused element — a keyframe marker, an effect row, the
 * variant picker — and is free-form because only the application knows what its focusable things are.
 *
 * Modelled rather than left to prose because the collision check depends on it. `←` moves a keyframe,
 * steps to the previous variant **and** steps the playhead; three bindings on one key and not a clash,
 * because no two of them are listening at the same moment. Without scopes the check reports three
 * false alarms, and the only way past a false alarm is to stop believing the check.
 *
 * The corollary is what makes it worth having: two groups that *share* a scope really do compete, and
 * a single lumped `focus` would have hidden that a keyframe marker and the variant picker both wanted
 * `Enter`. They are separate scopes because they are separate listeners.
 */
export type ShortcutScope = string;

export interface ShortcutGroup {
  readonly title: string;
  readonly shortcuts: readonly Shortcut[];
  /** Defaults to `window`, which is what most groups are. */
  readonly scope?: ShortcutScope;
}

/**
 * The chord for a command, formatted the way a menu prints it.
 *
 * `Ctrl+Shift+C`, from the same declaration the sheet draws as three keys. Returns nothing for a
 * command with no binding, which a menu renders as no shortcut rather than as an empty one.
 */
export function shortcutFor(groups: readonly ShortcutGroup[], command: string): string | undefined {
  for (const group of groups) {
    for (const shortcut of group.shortcuts) {
      if (shortcut.command === command) return shortcut.keys.join('+');
    }
  }
  return undefined;
}

/** Every binding, flattened — for a search box, or for a test that asserts nothing is bound twice. */
export function allShortcuts(groups: readonly ShortcutGroup[]): readonly Shortcut[] {
  return groups.flatMap((group) => group.shortcuts);
}

/**
 * Bindings that collide, as `chord → the actions that claim it`.
 *
 * Exported because it is the one property of a keymap worth asserting: two actions on one chord means
 * one of them cannot be performed, and which one wins depends on listener order — so it is a bug that
 * presents as "that shortcut does nothing" long after it was introduced.
 *
 * **Within a scope.** A chord shared by a window binding and a focused element's is not a collision:
 * they are never both listening. This used to advise callers to explain such a pair in the `note`,
 * which did not help — the check reported it anyway, and the only way past a false alarm is to stop
 * believing the check.
 */
export function conflictingShortcuts(
  groups: readonly ShortcutGroup[],
): ReadonlyMap<string, readonly string[]> {
  const byChord = new Map<string, string[]>();
  for (const group of groups) {
    for (const shortcut of group.shortcuts) {
      // Scoped key, plain chord in the message: the caller is told `Enter`, not `focus:enter`.
      const chord = shortcut.keys.join('+').toLowerCase();
      const key = `${group.scope ?? 'window'}\u0000${chord}`;
      byChord.set(key, [...(byChord.get(key) ?? []), shortcut.action]);
    }
  }

  return new Map(
    [...byChord]
      .filter(([, actions]) => actions.length > 1)
      .map(([key, actions]) => [key.split('\u0000')[1]!, actions]),
  );
}
