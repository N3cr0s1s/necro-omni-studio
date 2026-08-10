import { useEffect, useRef } from 'react';

/**
 * The keys that flip an editing mode.
 *
 * Snap, ripple and loop are switches rather than actions: they change what a later gesture *means*,
 * and an editor reaches for them between other operations without looking. They had no keys at all —
 * and the Snap toggle's own tooltip said `Snap (N)`, so the application was advertising a chord that
 * nothing listened for. A control that names a key it does not have is worse than one that names
 * none: the user presses it, nothing happens, and they stop believing the rest of the labels.
 *
 * Taken as a map rather than as named callbacks, so a fourth mode is one entry here and one line in
 * the shortcut sheet. The hook knows nothing about what any of them do.
 *
 * Unmodified single letters, like Fit's `F`: these change nothing in the document, so there is nothing
 * to undo and nothing to lose by pressing one by accident. Suppressed while a text field has focus,
 * for the reason every other key hook here is — typing a prompt must not silently turn snapping off.
 */

export type ModeKeyMap = Readonly<Record<string, () => void>>;

export function useModeKeys(keys: ModeKeyMap): void {
  const latest = useRef(keys);
  latest.current = keys;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      // Every modifier declined, not just Ctrl. `Alt+M` removes a marker and `Shift+S` splits every
      // track, so a mode key that fired on any chord ending in its letter would steal from them.
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

      const action = latest.current[event.key.toLowerCase()];
      if (action === undefined) return;

      action();
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
