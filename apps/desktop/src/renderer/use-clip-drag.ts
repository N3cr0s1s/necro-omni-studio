import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  type ClipId,
  type FrameIndex,
  type Result,
  type TimelineDocument,
  type TrackId,
  frameIndex,
  locateClip,
} from '@nos/core';
import {
  type EditError,
  type SnapCandidate,
  DEFAULT_SNAP_PIXELS,
  collectSnapCandidates,
  moveClip,
  slipClip,
  snapSpanTranslation,
  snapThresholdFrames,
  trimClipEnd,
  trimClipStart,
} from '@nos/editing';
import { type TimelineViewport, pxToFrames } from '@nos/ui';

/**
 * Dragging and trimming clips.
 *
 * The gesture rules the spec and the editing layer already agreed on, made real:
 *
 * - **One gesture is one undo step.** Every pointer move re-applies the operation to the document as it
 *   was when the drag *began*, so the drag is a preview; the store is committed once on release. A
 *   commit per move would fill the history with hundreds of entries and make undo useless.
 * - **A rejected edit snaps back with a reason.** Collisions are refused rather than resolved by
 *   displacing a neighbour, so the preview simply stops following the pointer and the reason is
 *   reported — silently moving material the user cannot see is the worst thing a timeline can do.
 * - **Snapping is computed from the document, not from pixels.** The threshold converts pixels to
 *   frames at the current zoom, so it feels the same distance at every zoom level.
 */

/**
 * What a drag on a clip does.
 *
 * `slip` is the spec's *csúsztatás*: the clip stays exactly where it is on the timeline and its
 * *content* slides inside that window. It is a separate gesture rather than a mode because it is the
 * one edit whose result is invisible in the clip's outline — nothing moves — so a user who triggered
 * it by accident would see no reason for the picture changing.
 */
export type DragKind = 'move' | 'trim-start' | 'trim-end' | 'slip';

export interface DragState {
  readonly clip: ClipId;
  readonly kind: DragKind;
  readonly originX: number;
  readonly document: TimelineDocument;
}

export interface ClipDrag {
  /** The document to render: the live preview while dragging, otherwise the committed one. */
  readonly document: TimelineDocument;
  readonly dragging: boolean;
  readonly rejection: string | undefined;
  /**
   * What the drag is currently locked to, if anything.
   *
   * Surfaced because snapping is otherwise indistinguishable from the clip refusing to follow the
   * pointer. A user who cannot see *what* it caught learns to distrust the feature and turns it off.
   */
  readonly snappedTo: SnapCandidate | undefined;
  begin(kind: DragKind, clip: ClipId, event: ReactPointerEvent<HTMLElement>): void;
}

export interface ClipDragOptions {
  readonly document: TimelineDocument;
  readonly viewport: TimelineViewport;
  readonly snapEnabled: boolean;
  /** Snap candidates include the playhead, which is where a user aligns a cut most often. */
  readonly playhead: FrameIndex;
  readonly commit: (label: string, next: TimelineDocument) => void;
}

export function useClipDrag(options: ClipDragOptions): ClipDrag {
  const { document, viewport, snapEnabled, playhead, commit } = options;

  const [drag, setDrag] = useState<DragState | undefined>(undefined);
  const [preview, setPreview] = useState<TimelineDocument | undefined>(undefined);
  const [rejection, setRejection] = useState<string | undefined>(undefined);
  const [snappedTo, setSnappedTo] = useState<SnapCandidate | undefined>(undefined);

  // Read inside the window listeners, which are attached once per gesture and must not close over a
  // stale document or zoom.
  const latest = useRef({ drag, viewport, snapEnabled, document, playhead });
  latest.current = { drag, viewport, snapEnabled, document, playhead };

  const begin = useCallback(
    (kind: DragKind, clip: ClipId, event: ReactPointerEvent<HTMLElement>) => {
      setDrag({ clip, kind, originX: event.clientX, document });
      setPreview(undefined);
      setRejection(undefined);
      setSnappedTo(undefined);
    },
    [document],
  );

  useEffect(() => {
    if (drag === undefined) return;

    function onMove(event: PointerEvent): void {
      const state = latest.current.drag;
      if (state === undefined) return;

      const deltaFrames = Math.round(pxToFrames(latest.current.viewport, event.clientX - state.originX));
      const result = applyDrag(state, deltaFrames, {
        snapEnabled: latest.current.snapEnabled,
        viewport: latest.current.viewport,
        playhead: latest.current.playhead,
      });

      if (result.ok) {
        setPreview(result.value.document);
        setSnappedTo(result.value.snappedTo);
        setRejection(undefined);
      } else {
        // The preview stops following the pointer and says why, rather than snapping the clip somewhere
        // the user did not ask for.
        setRejection(describeEditError(result.error));
      }
    }

    function onUp(): void {
      const state = latest.current.drag;
      setDrag(undefined);
      setSnappedTo(undefined);
      setPreview((current) => {
        if (current !== undefined && state !== undefined) {
          commit(labelFor(state.kind), current);
        }
        return undefined;
      });
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, commit]);

  return {
    document: preview ?? document,
    dragging: drag !== undefined,
    rejection,
    snappedTo,
    begin,
  };
}

function labelFor(kind: DragKind): string {
  if (kind === 'move') return 'move clip';
  if (kind === 'slip') return 'slip clip';
  return 'trim clip';
}

/**
 * Applies one pointer position to the document the gesture started from.
 *
 * Always from the *original* document, never from the previous preview: applying deltas cumulatively
 * accumulates rounding at every event, and a slow drag would end somewhere different from a fast one
 * covering the same distance.
 */
interface DragOutcome {
  readonly document: TimelineDocument;
  readonly snappedTo: SnapCandidate | undefined;
}

function applyDrag(
  state: DragState,
  deltaFrames: number,
  context: { snapEnabled: boolean; viewport: TimelineViewport; playhead: FrameIndex },
): Result<DragOutcome, EditError> {
  const located = locateClip(state.document, state.clip);
  if (located === undefined) return { ok: false, error: { kind: 'clip-not-found', clip: state.clip } };

  const { track, clip } = located;

  if (state.kind === 'trim-start') {
    return plain(trimClipStart(state.document, state.clip, deltaFrames));
  }
  if (state.kind === 'trim-end') {
    return plain(trimClipEnd(state.document, state.clip, deltaFrames));
  }
  if (state.kind === 'slip') {
    // Dragging left pulls later material into the window, which is what the hand expects: the content
    // follows the pointer, not the source read position.
    return plain(slipClip(state.document, state.clip, -deltaFrames));
  }

  const target = frameIndex(Math.max(0, clip.span.start + deltaFrames));
  const snap = context.snapEnabled
    ? snapSpanTranslation(
        target,
        clip.span.duration,
        // The clip being dragged is ignored, or it would snap to its own edges and never move.
        collectSnapCandidates(state.document, context.playhead, { ignoreClips: [state.clip] }),
        snapThresholdFrames(DEFAULT_SNAP_PIXELS, context.viewport.framesPerPixel),
      )
    : { frame: target };

  const moved = moveClip(state.document, state.clip, track.id as TrackId, snap.frame);
  return moved.ok ? { ok: true, value: { document: moved.value, snappedTo: snap.snappedTo } } : moved;
}

/** An operation that cannot snap, in the shape the caller expects. */
function plain(result: ReturnType<typeof trimClipStart>): Result<DragOutcome, EditError> {
  return result.ok ? { ok: true, value: { document: result.value, snappedTo: undefined } } : result;
}

/** A rejection the user can act on, rather than a discriminant. */
export function describeEditError(error: EditError): string {
  switch (error.kind) {
    case 'collision':
      return 'that position overlaps another clip';
    case 'track-locked':
      return 'the track is locked';
    case 'clip-not-found':
      return 'the clip is gone';
    case 'empty-result':
      return 'that would leave nothing of the clip';
    case 'source-exhausted':
      return `the source has ${error.available} frames left, ${error.requested} were asked for`;
    default:
      return `the edit was rejected: ${String(error.kind).replace(/-/g, ' ')}`;
  }
}
