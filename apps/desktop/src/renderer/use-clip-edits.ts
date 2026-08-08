import { useEffect, useMemo, useRef } from 'react';
import {
  type ClipId,
  type DocumentStore,
  type FrameIndex,
  type TimelineDocument,
  clipId,
  locateClip,
} from '@nos/core';
import {
  type EditError,
  liftClip,
  rippleDeleteClip,
  setClipEnabled,
  splitAllTracksAt,
  splitClip,
} from '@nos/editing';

/**
 * Removing, disabling and cutting clips.
 *
 * Every one of these operations has existed in `@nos/editing` since M3, tested, and none could be
 * invoked: the application could put clips on a timeline and never take one off. The Ripple toggle in
 * the toolbar was the same story from the other end — a control whose state nothing read.
 *
 * That toggle is what decides between the two ways to remove a clip, which is the only interesting
 * decision here. **Lift** leaves the gap, so everything downstream keeps its timing; **ripple** closes
 * it, pulling the rest of that track back. Neither is a safe default for the other's situation, which
 * is why the choice is a visible, persistent mode rather than a guess — and why holding shift gives
 * the other one without changing the mode.
 */

export interface ClipEdits {
  /** Removes the selection, honouring the ripple mode. */
  remove(): void;
  /** Removes the selection with the opposite of the current ripple mode. */
  removeOtherWay(): void;
  /** Disables an enabled clip and enables a disabled one. */
  toggleEnabled(): void;
  /** Splits the selected clip at the playhead. */
  split(): void;
  /** Splits every unlocked track at the playhead, keeping layers aligned. */
  splitAllTracks(): void;
  /** True when something is selected, so the shell can disable its buttons honestly. */
  readonly hasSelection: boolean;
}

export interface ClipEditOptions {
  readonly store: DocumentStore;
  readonly selected: ReadonlySet<string>;
  readonly playhead: FrameIndex;
  /** Whether removals close the gap. The toolbar's Ripple toggle. */
  readonly ripple: boolean;
  readonly onReject: (reason: string) => void;
  /** Clears a selection that no longer names anything. */
  readonly onRemoved: (clips: readonly ClipId[]) => void;
}

export function useClipEdits(options: ClipEditOptions): ClipEdits {
  // Read through a ref for the same reason the range actions do: these are reachable from a window
  // key listener that is attached once, and a closure over the mounting props would act on a document
  // and a selection that have both moved on.
  const latest = useRef(options);
  latest.current = options;

  const actions = useMemo<Omit<ClipEdits, 'hasSelection'>>(
    () => ({
      remove: () => removeSelection(latest.current, latest.current.ripple),
      removeOtherWay: () => removeSelection(latest.current, !latest.current.ripple),

      toggleEnabled() {
        const { store, selected, onReject } = latest.current;
        const targets = [...selected] as ClipId[];
        if (targets.length === 0) return;

        store.commit('toggle clip', (current) => {
          let next = current;
          for (const target of targets) {
            const located = locateClip(next, target);
            if (located === undefined) continue;
            const result = setClipEnabled(next, target, !located.clip.enabled);
            if (!result.ok) {
              onReject(describe(result.error));
              continue;
            }
            next = result.value;
          }
          return next;
        });
      },

      split() {
        const { store, selected, playhead, onReject } = latest.current;
        const target = [...selected][0] as ClipId | undefined;
        if (target === undefined) return;

        store.commit('split clip', (current) => {
          const result = splitClip(current, target, playhead, clipId(`${target}_b`));
          if (!result.ok) {
            onReject(describe(result.error));
            return current;
          }
          return result.value;
        });
      },

      splitAllTracks() {
        const { store, playhead, onReject } = latest.current;
        store.commit('split all tracks', (current) => {
          // Ids derived from the frame, so the same cut made twice produces the same document — which
          // is what keeps an undo comparison meaningful and a saved file diffable.
          let counter = 0;
          const result = splitAllTracksAt(current, playhead, () => {
            counter += 1;
            return clipId(`cut_${playhead}_${counter}`);
          });
          if (!result.ok) {
            onReject(describe(result.error));
            return current;
          }
          return result.value;
        });
      },
    }),
    [],
  );

  useEditKeys(actions);

  return { ...actions, hasSelection: options.selected.size > 0 };
}

/**
 * Removes every selected clip.
 *
 * One history entry for the whole selection, because removing three clips is one decision. Applying
 * them in a single commit also means a failure part-way through — a locked track among the selection
 * — leaves the others removed rather than rolling back work the user did want.
 */
function removeSelection(options: ClipEditOptions, ripple: boolean): void {
  const targets = [...options.selected] as ClipId[];
  if (targets.length === 0) return;

  const removed: ClipId[] = [];
  options.store.commit(ripple ? 'ripple delete' : 'delete clip', (current) => {
    let next = current;
    for (const target of targets) {
      const result = ripple ? rippleDeleteClip(next, target) : liftClip(next, target);
      if (!result.ok) {
        options.onReject(describe(result.error));
        continue;
      }
      next = result.value;
      removed.push(target);
    }
    return next;
  });

  // The selection is cleared after the fact rather than optimistically: a clip a locked track refused
  // to give up is still there, and still the thing the user has selected.
  if (removed.length > 0) options.onRemoved(removed);
}

/**
 * The edit keys.
 *
 * Window-level and suppressed in text fields, like the transport and range keys — an editor's Delete
 * has to work wherever the pointer is, and must never eat a character from a prompt.
 */
function useEditKeys(actions: Omit<ClipEdits, 'hasSelection'>): void {
  const latest = useRef(actions);
  latest.current = actions;

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
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const current = latest.current;
      switch (event.key) {
        case 'Delete':
        case 'Backspace':
          // Shift gives the other removal without changing the mode: an editor reaches for it once,
          // for one clip, and does not want the toolbar to have silently flipped afterwards.
          if (event.shiftKey) current.removeOtherWay();
          else current.remove();
          break;
        case 'e':
        case 'E':
          current.toggleEnabled();
          break;
        case 's':
        case 'S':
          if (event.shiftKey) current.splitAllTracks();
          else current.split();
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function describe(error: EditError): string {
  return `the edit was rejected: ${String(error.kind).replace(/-/g, ' ')}`;
}

/** What the Ripple toggle promises, for the control's own title. */
export function describeRippleMode(ripple: boolean): string {
  return ripple
    ? 'Delete closes the gap, pulling the rest of the track back'
    : 'Delete leaves a gap, so everything downstream keeps its timing';
}

/** Clips that no longer exist, for a caller pruning its selection. */
export function survivingSelection(
  document: TimelineDocument,
  selected: ReadonlySet<string>,
): ReadonlySet<string> {
  const kept = [...selected].filter((id) => locateClip(document, id as ClipId) !== undefined);
  return kept.length === selected.size ? selected : new Set(kept);
}
