import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  type ClipId,
  type FrameIndex,
  type Result,
  type TimelineDocument,
  frameIndex,
  locateClip,
} from '@nos/core';
import {
  type EditError,
  type SnapCandidate,
  DEFAULT_SNAP_PIXELS,
  collectSnapCandidates,
  clampRoll,
  clipAfter,
  clipBefore,
  type TrimEdge,
  eligibleTracksFor,
  limitedStart,
  moveClip,
  moveClipsBy,
  reachableTrimDelta,
  rollEdit,
  trackForOffset,
  slipClip,
  snapEdgeDelta,
  snapSpanTranslation,
  snapThresholdFrames,
  trimGroup,
  withLinkedClips,
} from '@nos/editing';
import { type TimelineViewport, pxToFrames } from '@nos/ui';
import { describeEditError } from './edit-errors.js';

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
export type DragKind = 'move' | 'trim-start' | 'trim-end' | 'slip' | 'roll';

export interface DragState {
  readonly clip: ClipId;
  readonly kind: DragKind;
  /**
   * The pair whose cut a roll moves, resolved when the drag begins.
   *
   * Resolved once rather than per pointer move: the two clips stop being adjacent as soon as the
   * first frame of the roll is applied to the preview, so looking them up again would find no shared
   * cut and abandon the gesture after one frame.
   */
  readonly rolling?: { readonly outgoing: ClipId; readonly incoming: ClipId };
  readonly originX: number;
  /**
   * Where the drag started vertically, so a clip can change track.
   *
   * Absent before this: only the horizontal axis was read, so a clip could not be moved between
   * tracks at all — the report was that video and audio alike were stuck on the row they began on.
   */
  readonly originY: number;
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
  /**
   * What is selected, so dragging one clip of a selection moves the whole thing.
   *
   * Without this a user who marqueed a scene and dragged it would find one clip moved and the rest
   * left behind — the worst outcome available, because it looks like it worked.
   */
  readonly selected: ReadonlySet<string>;
  /** Snap candidates include the playhead, which is where a user aligns a cut most often. */
  readonly playhead: FrameIndex;
  readonly commit: (label: string, next: TimelineDocument) => void;
}

export function useClipDrag(options: ClipDragOptions): ClipDrag {
  const { document, viewport, snapEnabled, selected, playhead, commit } = options;

  const [drag, setDrag] = useState<DragState | undefined>(undefined);
  const [preview, setPreview] = useState<TimelineDocument | undefined>(undefined);
  const [rejection, setRejection] = useState<string | undefined>(undefined);
  const [snappedTo, setSnappedTo] = useState<SnapCandidate | undefined>(undefined);

  // Read inside the window listeners, which are attached once per gesture and must not close over a
  // stale document or zoom.
  const latest = useRef({ drag, viewport, snapEnabled, document, playhead, selected });
  latest.current = { drag, viewport, snapEnabled, document, playhead, selected };

  const begin = useCallback(
    (kind: DragKind, clip: ClipId, event: ReactPointerEvent<HTMLElement>) => {
      // Shift turns a trim into a roll. A modifier rather than a handle of its own because the cut is
      // exactly where the two trim handles already are: a roll strip wide enough to grab would cover
      // one of them, and losing head-trim on every flush clip is a worse trade than a held key.
      const rolling = kind === 'roll' ? rollPair(document, clip, event) : undefined;
      setDrag({
        clip,
        kind,
        originX: event.clientX,
        originY: event.clientY,
        document,
        ...(rolling !== undefined ? { rolling } : {}),
      });
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
      const result = applyDrag(state, deltaFrames, event.clientY - state.originY, {
        snapEnabled: latest.current.snapEnabled,
        viewport: latest.current.viewport,
        playhead: latest.current.playhead,
        selected: latest.current.selected,
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
  deltaY: number,
  context: {
    snapEnabled: boolean;
    viewport: TimelineViewport;
    playhead: FrameIndex;
    selected: ReadonlySet<string>;
  },
): Result<DragOutcome, EditError> {
  const located = locateClip(state.document, state.clip);
  if (located === undefined) return { ok: false, error: { kind: 'clip-not-found', clip: state.clip } };

  const { track, clip } = located;

  if (state.kind === 'roll') {
    const pair = state.rolling;
    // Nothing to roll: the grabbed edge is not a shared cut. Reported rather than silently treated as
    // a trim, because a gesture that quietly became a different edit is worse than one that refuses.
    if (pair === undefined) {
      return { ok: false, error: { kind: 'no-shared-cut', clips: [state.clip, state.clip] } };
    }
    // Clamped so the cut slides up to the limit instead of the drag being refused past it — the same
    // rule a move follows. The source handles are still enforced by the trims underneath.
    const delta = clampRoll(state.document, pair.outgoing, pair.incoming, deltaFrames);
    return plain(
      rollEdit({ document: state.document, outgoing: pair.outgoing, incoming: pair.incoming, delta }),
    );
  }

  if (state.kind === 'trim-start' || state.kind === 'trim-end') {
    return applyTrim(state, state.kind === 'trim-start' ? 'start' : 'end', deltaFrames, context);
  }
  if (state.kind === 'slip') {
    // Dragging left pulls later material into the window, which is what the hand expects: the content
    // follows the pointer, not the source read position.
    return plain(slipClip(state.document, state.clip, -deltaFrames));
  }

  // Everything that travels with the grabbed clip: the rest of the selection when it is part of one,
  // plus whatever is linked to any of them. A video and the audio split from it are one thing to a
  // user, so a drag on either has to reach both or the two come apart at the first move.
  const group = withLinkedClips(
    state.document,
    context.selected.has(state.clip) ? ([...context.selected] as ClipId[]) : [state.clip],
  );

  const target = frameIndex(Math.max(0, clip.span.start + deltaFrames));
  const snap = context.snapEnabled
    ? snapSpanTranslation(
        target,
        clip.span.duration,
        // Everything being dragged is ignored, or the group would snap to its own edges.
        collectSnapCandidates(state.document, context.playhead, { ignoreClips: group }),
        snapThresholdFrames(DEFAULT_SNAP_PIXELS, context.viewport.framesPerPixel),
      )
    : { frame: target };

  // The row the pointer is over, among those that can hold this clip.
  const destination = trackForOffset(state.document.sequence.tracks, clip, track.id, deltaY) ?? {
    track: track.id,
    changed: false,
    deltaRows: 0,
  };

  if (group.length > 1) {
    // Translated as a set, so the clips keep their spacing and a run of adjacent ones can move at
    // all — applied one at a time, each would collide with the neighbour that has not moved yet.
    //
    // The row delta travels with it, applied within each clip's own kind. An imported video and its
    // audio are linked, so grabbing either drags both — and a group pinned to its tracks meant the
    // *common* case could never change row, which is what "I cannot move clips between tracks,
    // neither audio nor video" actually was.
    const moved = moveClipsBy(
      state.document,
      group,
      snap.frame - clip.span.start,
      destination.deltaRows,
      (member) => eligibleTracksFor(state.document.sequence.tracks, member),
    );
    return moved.ok
      ? { ok: true, value: { document: moved.value.document, snappedTo: snap.snappedTo } }
      : moved;
  }
  const targetTrack = state.document.sequence.tracks.find((candidate) => candidate.id === destination.track);
  if (targetTrack === undefined) {
    return { ok: false, error: { kind: 'track-not-found', track: destination.track } };
  }

  // Clamped rather than refused. A move that overlapped anything used to fail the whole gesture, so
  // the clip snapped back to where it started — "there is room and I cannot use it". It now travels
  // as far as it legitimately can, and the obstacle is on screen the whole time.
  const reachable = limitedStart(targetTrack, [state.clip], clip.span, snap.frame, {
    changingTrack: destination.changed,
  });

  const moved = moveClip(state.document, state.clip, destination.track, reachable);
  return moved.ok ? { ok: true, value: { document: moved.value, snappedTo: snap.snappedTo } } : moved;
}

/**
 * A trim, reaching everything linked to the clip and snapping to the cuts around it.
 *
 * Both halves of one report. Trimming moved only the clip under the pointer, so cutting the head off
 * an imported video left its own sound at the old length; and trimming was the one gesture that did
 * not snap, so an edge could not be landed on a neighbouring cut and a single black frame survived
 * between two clips that looked adjacent.
 *
 * Snapped **before** the group is trimmed, not after: the snap decides which frame the edge is asked
 * for, and the trim decides whether it may have it.
 */
function applyTrim(
  state: DragState,
  edge: TrimEdge,
  deltaFrames: number,
  context: {
    snapEnabled: boolean;
    viewport: TimelineViewport;
    playhead: FrameIndex;
  },
): Result<DragOutcome, EditError> {
  const located = locateClip(state.document, state.clip);
  if (located === undefined) return { ok: false, error: { kind: 'clip-not-found', clip: state.clip } };

  const group = withLinkedClips(state.document, [state.clip]);
  const span = located.clip.span;
  const from = edge === 'start' ? span.start : frameIndex(span.start + span.duration);

  // The group is excluded from its own candidates, or the edge being dragged would snap to where it
  // already is and the gesture would never leave the frame it started on.
  const snap = context.snapEnabled
    ? snapEdgeDelta(
        from,
        deltaFrames,
        collectSnapCandidates(state.document, context.playhead, { ignoreClips: group }),
        snapThresholdFrames(DEFAULT_SNAP_PIXELS, context.viewport.framesPerPixel),
      )
    : { delta: deltaFrames, snappedTo: undefined };

  const request = { document: state.document, clip: state.clip, edge, delta: snap.delta };
  const trimmed = trimGroup(request);
  if (trimmed.ok) {
    return { ok: true, value: { document: trimmed.value, snappedTo: snap.snappedTo } };
  }

  // Blocked: travel as far as the group legitimately can rather than failing the whole gesture, the
  // same rule a blocked move already follows. A pair refusing outright would be *harder* to trim
  // than a lone clip, which is the wrong way round.
  const reachable = reachableTrimDelta(request);
  if (reachable === 0) return trimmed;

  const limited = trimGroup({ ...request, delta: reachable });
  return limited.ok ? { ok: true, value: { document: limited.value, snappedTo: undefined } } : limited;
}

/** An operation that cannot snap, in the shape the caller expects. */
function plain(result: Result<TimelineDocument, EditError>): Result<DragOutcome, EditError> {
  return result.ok ? { ok: true, value: { document: result.value, snappedTo: undefined } } : result;
}

/**
 * The pair whose cut a roll should move, from the edge that was grabbed.
 *
 * Grabbing a clip's head rolls the cut it shares with the clip before it; grabbing its tail rolls the
 * one it shares with the clip after. `undefined` when that edge is not a shared cut at all — the
 * start of the sequence, or a gap — and the caller refuses rather than falling back to a trim.
 */
function rollPair(
  document: TimelineDocument,
  clip: ClipId,
  event: ReactPointerEvent<HTMLElement>,
): { readonly outgoing: ClipId; readonly incoming: ClipId } | undefined {
  const side = (event.currentTarget as HTMLElement).dataset['trimHandle'];

  if (side === 'start') {
    const previous = clipBefore(document, clip);
    return previous === undefined ? undefined : { outgoing: previous, incoming: clip };
  }

  const next = clipAfter(document, clip);
  return next === undefined ? undefined : { outgoing: clip, incoming: next };
}
