import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ClipId,
  type DocumentStore,
  type FrameIndex,
  type TimelineDocument,
  clipId,
  effectInstanceId,
  frameIndex,
  locateClip,
} from '@nos/core';
import {
  type ClipAttributes,
  type Clipboard,
  EMPTY_CLIPBOARD,
  allClips,
  clearWorkRange,
  closeGapBefore,
  crossfadeAtCut,
  defaultCrossfadeFrames,
  maxCrossfadeAtCut,
  copyAttributes,
  copyClips,
  describeAttributes,
  pasteAttributes,
  firstFreePaste,
  pasteClips,
  liftClip,
  rippleDeleteRange,
  rippleDeleteClip,
  setClipEnabled,
  splitAllTracksAt,
  splitClip,
  withLinkedClips,
} from '@nos/editing';
import { describeEditError } from './edit-errors.js';

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
  /**
   * Pulls the selection back until it meets what precedes it.
   *
   * Bound to a key as well as offered in the menu because the gap it closes is one frame wide most of
   * the time — invisible on screen, unmistakable in the delivered file — so the user who needs it
   * needs it repeatedly, on clip after clip, and a menu round trip each time is the difference
   * between a fix and a chore.
   */
  closeGap(): void;
  /**
   * Crossfades the cut after the selected clip, growing both clips into their handles.
   *
   * The half of the crossfade that keeps the sequence's timing — dropping a clip onto its neighbour
   * is the other half and shortens it. Which one a person means is decided by whether the cut is
   * already where they want it, so both are offered rather than one being chosen for them.
   */
  crossfadeAtCut(): void;
  /**
   * Removes the marked in/out range from every unlocked track and closes the gaps.
   *
   * Every track, not the selected one: a range is a span of the *programme*, and taking it out of
   * the picture while leaving it in the sound is not something anyone marks a range to do.
   */
  removeRange(): void;
  /** True when a range is marked, so the control can be offered only when it means something. */
  readonly hasRange: boolean;
  /** Copies the selection. */
  copy(): void;
  /** Copies the selection and removes it, honouring the ripple mode. */
  cut(): void;
  /** Pastes at the playhead, or just past whatever is in the way. */
  paste(): void;
  /** Copies the selection and pastes it immediately after itself. */
  duplicate(): void;
  readonly canPaste: boolean;
  /** Copies the look of the selected clip: its effects, framing, speed and level. */
  copyAttributes(): void;
  /** Applies that look to every selected clip. */
  pasteAttributes(): void;
  /** What would be pasted, for a control that can say so. */
  readonly attributeSummary: string | undefined;
  /** Selects everything on the timeline. */
  selectAll(): void;
  /** Drops the selection, which is what Escape means everywhere. */
  clearSelection(): void;
  /** True when something is selected, so the shell can disable its buttons honestly. */
  readonly hasSelection: boolean;
}

/** The verbs, without the state the shell reads off the document. */
type EditActions = Omit<ClipEdits, 'hasSelection' | 'hasRange' | 'canPaste' | 'attributeSummary'>;

export interface ClipEditOptions {
  readonly store: DocumentStore;
  readonly selected: ReadonlySet<string>;
  readonly playhead: FrameIndex;
  /** Whether removals close the gap. The toolbar's Ripple toggle. */
  readonly ripple: boolean;
  readonly onReject: (reason: string) => void;
  /** Clears a selection that no longer names anything. */
  readonly onRemoved: (clips: readonly ClipId[]) => void;
  /** Selects what was just pasted, which is what a user acts on next. */
  readonly onPasted?: (clips: readonly ClipId[]) => void;
  /** Replaces the selection outright, for select-all and for clearing it. */
  readonly onSelect?: (clips: readonly ClipId[]) => void;
}

export function useClipEdits(options: ClipEditOptions): ClipEdits {
  // Held in a ref rather than in state: nothing renders differently for its contents, and putting it
  // in state would re-render the whole editor on every copy.
  const clipboard = useRef<Clipboard>(EMPTY_CLIPBOARD);
  const [canPaste, setCanPaste] = useState(false);
  // The look, held separately from the clip clipboard: copying a grade must not lose the clips a
  // user copied a moment earlier, and the two are reached by different keys for that reason.
  const attributes = useRef<ClipAttributes | undefined>(undefined);
  const [attributeSummary, setAttributeSummary] = useState<string | undefined>(undefined);
  // Read through a ref for the same reason the range actions do: these are reachable from a window
  // key listener that is attached once, and a closure over the mounting props would act on a document
  // and a selection that have both moved on.
  const latest = useRef(options);
  latest.current = options;

  const actions = useMemo<EditActions>(
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
              onReject(describeEditError(result.error));
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
            onReject(describeEditError(result.error));
            return current;
          }
          return result.value;
        });
      },

      copy() {
        const { store, selected } = latest.current;
        // Linked partners come too, or pasting the copy would produce a silent picture.
        const document = store.getDocument();
        clipboard.current = copyClips(document, withLinkedClips(document, [...selected] as ClipId[]));
        setCanPaste(clipboard.current.entries.length > 0);
      },

      cut() {
        const { store, selected } = latest.current;
        const document = store.getDocument();
        clipboard.current = copyClips(document, withLinkedClips(document, [...selected] as ClipId[]));
        setCanPaste(clipboard.current.entries.length > 0);
        removeSelection(latest.current, latest.current.ripple);
      },

      paste() {
        pasteAt(latest.current, clipboard.current, latest.current.playhead);
      },

      duplicate() {
        // Copy and paste in one action, landing immediately after the original — the shape a user
        // means by "another one of these", without making them find the gap.
        const { store, selected } = latest.current;
        const document = store.getDocument();
        const copied = copyClips(document, withLinkedClips(document, [...selected] as ClipId[]));
        if (copied.entries.length === 0) return;

        const origin = Math.min(...copied.entries.map((entry) => entry.clip.span.start));
        pasteAt(latest.current, copied, frameIndex(origin + copied.durationFrames));
      },

      closeGap() {
        const { store, selected, onReject } = latest.current;
        const target = [...selected][0] as ClipId | undefined;
        if (target === undefined) return;

        store.commit('close the gap', (current) => {
          const closed = closeGapBefore(current, target);
          if (!closed.ok) {
            onReject(describeEditError(closed.error));
            return current;
          }
          return closed.value;
        });
      },

      crossfadeAtCut() {
        const { store, selected, onReject } = latest.current;
        const target = [...selected][0] as ClipId | undefined;
        if (target === undefined) return;

        store.commit('crossfade at the cut', (current) => {
          // The length is recomputed here rather than passed in, so the keyboard and the menu row
          // cannot disagree about what this cut can carry.
          const frames = Math.min(
            defaultCrossfadeFrames(current.frameRate),
            maxCrossfadeAtCut(current, target),
          );
          const made = crossfadeAtCut({ document: current, clip: target, frames });
          if (!made.ok) {
            onReject(describeEditError(made.error));
            return current;
          }
          return made.value;
        });
      },

      copyAttributes() {
        const { store, selected } = latest.current;
        const source = [...selected][0] as ClipId | undefined;
        if (source === undefined) return;

        const copied = copyAttributes(store.getDocument(), source);
        attributes.current = copied;
        setAttributeSummary(copied === undefined ? undefined : describeAttributes(copied));
      },

      pasteAttributes() {
        const { store, selected, onReject } = latest.current;
        const source = attributes.current;
        if (source === undefined || selected.size === 0) return;

        store.commit('paste attributes', (current) => {
          const result = pasteAttributes(current, {
            targets: [...selected] as ClipId[],
            attributes: source,
            // Derived from the target and the position in the stack, so pasting the same look twice
            // produces the same document — the property that keeps undo and a saved file comparable.
            effectId: (target, index) => effectInstanceId(`${target}_attr${index}`),
          });
          if (!result.ok) {
            onReject(describeEditError(result.error));
            return current;
          }
          return result.value.document;
        });
      },

      selectAll() {
        const { store, onSelect } = latest.current;
        onSelect?.(allClips(store.getDocument()));
      },

      clearSelection() {
        latest.current.onSelect?.([]);
      },

      removeRange() {
        const { store, onReject } = latest.current;
        const range = latest.current.store.getDocument().sequence.workRange;
        if (range === undefined) return;

        store.commit('ripple delete range', (current) => {
          let next = current;
          let counter = 0;
          for (const track of current.sequence.tracks) {
            if (track.locked) continue;
            const result = rippleDeleteRange(next, track.id, range, () => {
              counter += 1;
              return clipId(`range_${range.start}_${counter}`);
            });
            if (!result.ok) {
              onReject(describeEditError(result.error));
              continue;
            }
            next = result.value;
          }
          // The range described a section that no longer exists; leaving the marks would invite the
          // user to remove the material that has just moved into their place.
          return clearWorkRange(next);
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
            onReject(describeEditError(result.error));
            return current;
          }
          return result.value;
        });
      },
    }),
    [],
  );

  useEditKeys(actions);

  return {
    ...actions,
    canPaste,
    attributeSummary,
    hasSelection: options.selected.size > 0,
    hasRange: options.store.getDocument().sequence.workRange !== undefined,
  };
}

/**
 * Pastes a clipboard, moving forward past anything in the way.
 *
 * A refusal is turned into the result the user wanted rather than reported: they asked to put
 * something down, and "there is already a clip there" is a fact they can see. What they cannot see is
 * where the next gap is, which is the part worth doing for them.
 */
function pasteAt(options: ClipEditOptions, clipboard: Clipboard, at: FrameIndex): void {
  if (clipboard.entries.length === 0) return;

  options.store.commit('paste', (current) => {
    const target = firstFreePaste(current, clipboard, at);
    const ids = clipboard.entries.map((entry, index) => clipId(`${entry.clip.id}_copy${target}_${index}`));

    const result = pasteClips(current, clipboard, { at: target, ids });
    if (!result.ok) {
      options.onReject(describeEditError(result.error));
      return current;
    }
    options.onPasted?.(result.value.clips);
    return result.value.document;
  });
}

/**
 * Removes every selected clip.
 *
 * One history entry for the whole selection, because removing three clips is one decision. Applying
 * them in a single commit also means a failure part-way through — a locked track among the selection
 * — leaves the others removed rather than rolling back work the user did want.
 */
function removeSelection(options: ClipEditOptions, ripple: boolean): void {
  if (options.selected.size === 0) return;
  // A video and the audio split from it are one thing to a user: deleting the picture and leaving the
  // sound playing over the next shot is never what was meant.
  const targets = withLinkedClips(options.store.getDocument(), [...options.selected] as ClipId[]);

  const removed: ClipId[] = [];
  options.store.commit(ripple ? 'ripple delete' : 'delete clip', (current) => {
    let next = current;
    for (const target of targets) {
      const result = ripple ? rippleDeleteClip(next, target) : liftClip(next, target);
      if (!result.ok) {
        options.onReject(describeEditError(result.error));
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
function useEditKeys(actions: EditActions): void {
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
      if (event.altKey) return;

      const current = latest.current;

      // The clipboard chords. Nothing else in the application claims them, and a user who has ever
      // used another editor will try them before reading anything.
      if (event.ctrlKey || event.metaKey) {
        // Shift turns the clip clipboard into the *attribute* clipboard, which is how every editor
        // that has both spells the distinction.
        if (event.shiftKey) {
          switch (event.key.toLowerCase()) {
            case 'c':
              current.copyAttributes();
              break;
            case 'v':
              current.pasteAttributes();
              break;
            default:
              return;
          }
          event.preventDefault();
          return;
        }

        switch (event.key.toLowerCase()) {
          case 'c':
            current.copy();
            break;
          case 'x':
            current.cut();
            break;
          case 'v':
            current.paste();
            break;
          case 'd':
            current.duplicate();
            break;
          case 'a':
            current.selectAll();
            break;
          default:
            return;
        }
        event.preventDefault();
        return;
      }

      switch (event.key) {
        case 'Escape':
          current.clearSelection();
          break;
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
        case 'g':
        case 'G':
          current.closeGap();
          break;
        case 'f':
        case 'F':
          // Shift only: bare `F` fits the sequence to the window, which is one of the bindings a
          // person uses most, and taking it for a rarer edit would be a poor trade.
          if (!event.shiftKey) return;
          current.crossfadeAtCut();
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
