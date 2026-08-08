import { useEffect, useMemo, useRef, useState } from 'react';
import { type FrameIndex, type TimelineDocument, formatFrames } from '@nos/core';
import {
  addMarker,
  clearWorkRange,
  markIn,
  markOut,
  markerAfter,
  markerBefore,
  removeMarker,
} from '@nos/editing';

/**
 * In/out marks and markers, and the keys that drive them.
 *
 * The document has treated the work range as load-bearing from the start — it bounds playback, it is
 * the default export range, and it feeds the snapping candidates — but nothing could set it. This is
 * the missing half: the actions, and the keys an editor expects to reach them by.
 *
 * The keys are the point rather than a convenience. Marking in and out is done constantly, between
 * every other operation, and a round trip to a toolbar button for each one is the difference between
 * a usable editor and a demonstration of one. The buttons stay because a shortcut nobody knows about
 * does not exist.
 */

export interface WorkRangeActions {
  markIn(): void;
  markOut(): void;
  clear(): void;
  addMarker(): void;
  removeMarkerHere(): void;
  toPreviousMarker(): void;
  toNextMarker(): void;
}

export interface WorkRangeOptions {
  readonly document: TimelineDocument;
  readonly playhead: FrameIndex;
  /** One history entry per action: marking is a single decision, not a gesture to coalesce. */
  readonly commit: (label: string, next: TimelineDocument) => void;
  readonly seek: (frame: FrameIndex) => void;
}

export interface WorkRange extends WorkRangeActions {
  /**
   * What the last action did, when it did something the user did not literally ask for.
   *
   * Only the surprising outcomes are reported. "Marked in" needs no message — the ruler shows it —
   * but "the out point moved to keep the range valid" is a change to something the user did not
   * touch, and a silent one would be found later as an export of the wrong length.
   */
  readonly notice: string | undefined;
}

export function useWorkRange(options: WorkRangeOptions): WorkRange {
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // Every handler reads through this ref rather than closing over the props. The handlers have to
  // stay stable — they are attached to a window key listener — but they must act on the *current*
  // document, and a closure over the one that existed when the listener was attached would silently
  // discard every edit made since.
  const latest = useRef({ ...options, notify: setNotice });
  latest.current = { ...options, notify: setNotice };

  const actions = useMemo<WorkRangeActions>(
    () => ({
      markIn() {
        const { document: current, playhead: at, commit: apply, notify: say } = latest.current;
        const result = markIn(current, at);
        if (!result.ok) return;
        apply('mark in', result.value.document);
        if (result.value.outcome.kind === 'pushed') say?.('out point moved to keep the range valid');
      },

      markOut() {
        const { document: current, playhead: at, commit: apply, notify: say } = latest.current;
        const result = markOut(current, at);
        if (!result.ok) return;
        apply('mark out', result.value.document);
        if (result.value.outcome.kind === 'pushed') say?.('in point moved to keep the range valid');
      },

      clear() {
        const { document: current, commit: apply } = latest.current;
        const next = clearWorkRange(current);
        // Unchanged when there was no range: committing anyway would put an undo entry on the stack
        // that undoes nothing, which is worse than the key doing nothing.
        if (next !== current) apply('clear in/out', next);
      },

      addMarker() {
        const { document: current, playhead: at, commit: apply } = latest.current;
        // Labelled by position rather than prompting for a name. A dialog between the user and a
        // marker is what stops markers from being used; renaming can come later, unnamed cannot.
        const label = formatFrames(at, current.frameRate);
        apply('add marker', addMarker(current, { frame: at, label }));
      },

      removeMarkerHere() {
        const { document: current, playhead: at, commit: apply } = latest.current;
        const next = removeMarker(current, at);
        if (next !== current) apply('remove marker', next);
      },

      toPreviousMarker() {
        const { document: current, playhead: at, seek: go } = latest.current;
        const marker = markerBefore(current, at);
        if (marker !== undefined) go(marker.frame);
      },

      toNextMarker() {
        const { document: current, playhead: at, seek: go } = latest.current;
        const marker = markerAfter(current, at);
        if (marker !== undefined) go(marker.frame);
      },
    }),
    [],
  );

  useRangeKeys(actions);

  // Notices expire. One that stayed would still be on screen an hour later, describing an action the
  // user no longer remembers taking, which is how a status line stops being read at all.
  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return useMemo(() => ({ ...actions, notice }), [actions, notice]);
}

/** Long enough to read a short line, short enough not to outlive its context. */
const NOTICE_MS = 5000;

/**
 * The shortcuts.
 *
 * Window-level and suppressed while a text field has focus, for the same reason the transport keys
 * are: an editor's marks have to work wherever the pointer is, but typing a prompt must never move
 * the in point.
 */
function useRangeKeys(actions: WorkRangeActions): void {
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
      if (event.ctrlKey || event.metaKey) return;

      const key = event.key.toLowerCase();
      const current = latest.current;

      if (event.altKey) {
        // Alt is the modifier for "the other thing this key does", so the plain keys stay on the
        // action performed hundreds of times a session.
        switch (key) {
          case 'x':
            current.clear();
            break;
          case 'm':
            current.removeMarkerHere();
            break;
          case 'arrowleft':
            current.toPreviousMarker();
            break;
          case 'arrowright':
            current.toNextMarker();
            break;
          default:
            return;
        }
        event.preventDefault();
        return;
      }

      switch (key) {
        case 'i':
          current.markIn();
          break;
        case 'o':
          current.markOut();
          break;
        case 'm':
          current.addMarker();
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

/** Frames the transport should stop at, honouring the in/out range. */
export function playbackEnd(document: TimelineDocument, sequenceEnd: number): number {
  const range = document.sequence.workRange;
  return range === undefined ? sequenceEnd : range.start + range.duration;
}
