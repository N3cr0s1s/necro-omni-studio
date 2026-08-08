import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DocumentStore,
  type FrameIndex,
  type TimelineDocument,
  documentEnd,
  frameIndex,
  spanFromBounds,
} from '@nos/core';
import { type TimelineViewport, createViewport, scrollByPx, scrollToReveal, zoomToFit } from '@nos/ui';

/**
 * Where the timeline is looking, and the keys that move it.
 *
 * The viewport could zoom and nothing else: `scrollFrame` changed only as a side effect of zooming,
 * so the view never moved on its own. During playback the playhead simply left the right edge and the
 * timeline sat still — the material being played was off screen, which is the one moment an editor is
 * definitely watching. There was also no way to scroll at all, and `zoomToFit` had been written and
 * tested with nothing calling it.
 *
 * Undo and redo live here too, because they are the same kind of thing: a key an editor presses
 * without looking, which had buttons in the inspector and no keyboard at all. Nothing else in the
 * application claims a `Ctrl` chord, so the other key hooks decline modified keys and this one takes
 * exactly the two.
 */

export interface TimelineView {
  readonly viewport: TimelineViewport;
  /** Zooms about a pixel anchor, which is what a wheel gesture means. */
  zoomAt(framesPerPixel: number, anchorPx: number): void;
  /** Scrolls by a pixel delta, for a wheel or a trackpad swipe. */
  scrollBy(deltaPx: number): void;
  /** Frames the whole sequence, or the marked range when there is one. */
  fit(): void;
}

export interface TimelineViewOptions {
  readonly document: TimelineDocument;
  readonly store: DocumentStore;
  readonly widthPx: number;
  readonly playhead: FrameIndex;
  /** True while the transport is running, which is when the view should follow. */
  readonly playing: boolean;
}

export function useTimelineView(options: TimelineViewOptions): TimelineView {
  const { document, store, widthPx, playhead, playing } = options;
  const [framesPerPixel, setFramesPerPixel] = useState(1);
  const [scrollFrame, setScrollFrame] = useState<FrameIndex>(frameIndex(0));

  const viewport = useMemo(
    () => createViewport({ framesPerPixel, scrollFrame, widthPx, frameRate: document.frameRate }),
    [framesPerPixel, scrollFrame, widthPx, document.frameRate],
  );

  const latest = useRef({ viewport, document });
  latest.current = { viewport, document };

  /**
   * Follows the playhead while the transport runs.
   *
   * Only while playing. A user scrubbing or dragging is looking at something they chose to look at,
   * and yanking the view back would fight them — where during playback the playhead is the only thing
   * worth looking at. `scrollToReveal` returns the same viewport when the frame is comfortably inside,
   * so this costs nothing on the frames where nothing needs to move.
   */
  useEffect(() => {
    if (!playing) return;
    const revealed = scrollToReveal(latest.current.viewport, playhead);
    if (revealed.scrollFrame !== latest.current.viewport.scrollFrame) {
      setScrollFrame(revealed.scrollFrame);
    }
  }, [playing, playhead]);

  const zoomAtPixel = useCallback((next: number, anchorPx: number) => {
    const current = latest.current.viewport;
    setFramesPerPixel(next);
    // Anchored so the frame under the pointer stays under the pointer — a zoom that recentred instead
    // would move the material the user was pointing at, every time.
    //
    // Rounded, and that is not a detail: `frameIndex` refuses a non-integer, and the anchor arithmetic
    // produces one for almost every zoom step. Without this, every wheel zoom threw — which is what
    // it had been doing, unnoticed, because nothing was watching the renderer's console.
    const anchored = current.scrollFrame + anchorPx * (current.framesPerPixel - next);
    setScrollFrame(frameIndex(Math.max(0, Math.round(anchored))));
  }, []);

  const scrollBy = useCallback((deltaPx: number) => {
    setScrollFrame(scrollByPx(latest.current.viewport, deltaPx).scrollFrame);
  }, []);

  const fit = useCallback(() => {
    const { viewport: current, document: doc } = latest.current;
    // The marked range when there is one: a user who marked a section and asked to fit means that
    // section, not the whole programme it sits in.
    const span = doc.sequence.workRange ?? spanFromBounds(frameIndex(0), documentEnd(doc));
    const fitted = zoomToFit(
      current,
      span.duration > 0 ? span : spanFromBounds(frameIndex(0), frameIndex(1)),
    );
    setFramesPerPixel(fitted.framesPerPixel);
    setScrollFrame(fitted.scrollFrame);
  }, []);

  useHistoryKeys(store, fit);

  return { viewport, zoomAt: zoomAtPixel, scrollBy, fit };
}

/**
 * Undo, redo and fit.
 *
 * Attached to the window like the other editor keys and suppressed in text fields, so undo in a
 * prompt box stays the text field's own. `Ctrl+Shift+Z` and `Ctrl+Y` both redo: the first is what
 * this application's platform uses, the second is what a user arriving from elsewhere will try, and
 * there is nothing else for either to mean.
 */
function useHistoryKeys(store: DocumentStore, fit: () => void): void {
  const latest = useRef({ store, fit });
  latest.current = { store, fit };

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

      const key = event.key.toLowerCase();

      if (!event.ctrlKey && !event.metaKey) {
        // Unmodified, because it is a view change and not an edit — nothing to undo, nothing to lose.
        if (key === 'f' && !event.altKey) {
          latest.current.fit();
          event.preventDefault();
        }
        return;
      }
      if (event.altKey) return;

      if (key === 'z') {
        if (event.shiftKey) latest.current.store.redo();
        else latest.current.store.undo();
      } else if (key === 'y') {
        latest.current.store.redo();
      } else {
        return;
      }
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/**
 * Pixels a wheel event should scroll the timeline by.
 *
 * A trackpad reports horizontal intent in `deltaX`; a mouse wheel has none, so shift is the
 * conventional stand-in. Reading both means the same gesture works on both devices without the user
 * discovering which one this application happens to have been written for.
 */
export function wheelScrollPx(event: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey: boolean;
}): number {
  if (event.deltaX !== 0) return event.deltaX;
  return event.shiftKey ? event.deltaY : 0;
}
