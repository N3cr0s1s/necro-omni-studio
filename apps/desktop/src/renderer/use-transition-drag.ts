import { type PointerEvent as ReactPointerEvent, useCallback, useRef } from 'react';
import type { EffectInstanceId, TimelineDocument, Transition } from '@nos/core';
import { MIN_TRANSITION_FRAMES, addTransition } from '@nos/editing';
import { type TimelineViewport, pxToFrames } from '@nos/ui';

/**
 * Dragging a transition's trailing edge to change how long the overlap is.
 *
 * ## Why this re-runs `addTransition` rather than editing the span
 *
 * A transition is not a decoration sitting on top of two clips — it *is* the overlap, and its length
 * is the number of frames both clips play. Writing a new span directly would leave the clips where
 * they were, and the document would then claim an overlap the clips do not have: the compositor would
 * blend frames one of them no longer covers. `addTransition` already treats "change the length" as the
 * same gesture as "create it", undoing the old overlap and rebuilding both edges, which is exactly
 * what this needs.
 *
 * ## Why a refused drag is silent
 *
 * The operation refuses when there is not enough material beyond a cut to lengthen the overlap. That
 * is not an error to report — it is the edge of what the media allows, and the honest feedback is the
 * band simply stopping. A message per pointer move would be a hundred messages.
 */

export interface TransitionDrag {
  begin(transition: Transition, event: ReactPointerEvent<HTMLElement>): void;
}

export interface TransitionDragOptions {
  readonly document: TimelineDocument;
  readonly viewport: TimelineViewport;
  /** One label for the whole gesture, so undo takes back the drag rather than each frame of it. */
  readonly commit: (label: string, next: TimelineDocument) => void;
}

export function useTransitionDrag({ document, viewport, commit }: TransitionDragOptions): TransitionDrag {
  // The document as it was when the gesture started. Every move is computed from *that* rather than
  // from the last result, so a drag out and back returns exactly where it began instead of
  // accumulating rounding.
  const origin = useRef<{ document: TimelineDocument; frames: number; clientX: number } | undefined>(
    undefined,
  );

  const begin = useCallback(
    (transition: Transition, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;

      origin.current = {
        document,
        frames: transition.span.duration as number,
        clientX: event.clientX,
      };

      const target = event.currentTarget;
      target.setPointerCapture?.(event.pointerId);

      const move = (moved: PointerEvent): void => {
        const start = origin.current;
        if (start === undefined) return;

        const frames = Math.max(
          MIN_TRANSITION_FRAMES,
          Math.round(start.frames + pxToFrames(viewport, moved.clientX - start.clientX)),
        );
        if (frames === start.frames) return;

        const result = addTransition(start.document, {
          id: transition.id,
          from: transition.from,
          to: transition.to,
          effect: transition.effect,
          durationFrames: frames,
          params: transition.params,
        });
        // Refused means the media does not reach that far. The band stops; nothing is said.
        if (result.ok) commit('transition length', result.value);
      };

      const finish = (): void => {
        origin.current = undefined;
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', finish);
        target.removeEventListener('pointercancel', finish);
      };

      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', finish);
      target.addEventListener('pointercancel', finish);
    },
    [commit, document, viewport],
  );

  return { begin };
}

/** Finds a transition by id across every video track. */
export function findTransition(document: TimelineDocument, id: EffectInstanceId): Transition | undefined {
  for (const track of document.sequence.tracks) {
    if (track.kind !== 'video') continue;
    const found = track.transitions.find((entry) => entry.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}
