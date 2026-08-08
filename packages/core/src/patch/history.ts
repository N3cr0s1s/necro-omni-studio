/**
 * Undo/redo history.
 *
 * ## Why snapshots rather than inverse patches
 *
 * The spec's hard requirement is that a keyframe or clip drag is a *single* undo step.
 * Two designs satisfy that: recording each operation with a hand-written inverse, or
 * snapshotting the document and coalescing snapshots within a gesture. This uses
 * snapshots, because every operation in this codebase already produces a new immutable
 * document with structural sharing — the unchanged tracks, clips and keyframe arrays are
 * the *same objects* in both snapshots, so a snapshot costs a handful of pointers rather
 * than a document copy. Hand-written inverses would be strictly more code and would put
 * a correctness burden on every future edit operation, in a codebase whose whole premise
 * is that implementations change often.
 *
 * ## Coalescing
 *
 * Coalescing is driven by an explicit gesture scope, not by a time window. Time-based
 * heuristics ("merge commits under 300 ms apart") produce histories that depend on how
 * fast the user moved the mouse, which is untestable and occasionally wrong. A gesture is
 * opened when a drag starts and closed when the pointer is released; every commit inside
 * it replaces the gesture's single entry.
 */

/** One undoable state. */
export interface HistoryEntry<TDocument> {
  /** Shown in the UI: "Move clip", "Trim clip", "Add effect". */
  readonly label: string;
  readonly document: TDocument;
}

export interface HistoryOptions {
  /**
   * Cap on undo depth. Bounds memory on a long session; structural sharing means the
   * real cost is the number of *changed* subtrees, not entries × document size.
   */
  readonly limit: number;
}

export const DEFAULT_HISTORY_LIMIT = 200;

export interface HistoryState<TDocument> {
  readonly present: HistoryEntry<TDocument>;
  readonly past: readonly HistoryEntry<TDocument>[];
  readonly future: readonly HistoryEntry<TDocument>[];
  /** Label of the open gesture, if one is in progress. */
  readonly openGesture?: string;
}

export function createHistory<TDocument>(
  document: TDocument,
  label = 'Open project',
): HistoryState<TDocument> {
  return { present: { label, document }, past: [], future: [] };
}

/**
 * Records a new state.
 *
 * Committing always clears the redo stack: once the user edits after undoing, the
 * abandoned branch is unreachable, and keeping it would make redo mean something
 * different depending on invisible state.
 *
 * Inside an open gesture the present entry is *replaced* rather than pushed, so the whole
 * drag collapses to one undo step. The gesture's original label is kept — a drag is
 * "Move clip", not "Move clip (final position)".
 */
export function commit<TDocument>(
  state: HistoryState<TDocument>,
  document: TDocument,
  label: string,
  options: HistoryOptions = { limit: DEFAULT_HISTORY_LIMIT },
): HistoryState<TDocument> {
  if (state.openGesture !== undefined) {
    return {
      ...state,
      present: { label: state.openGesture, document },
      future: [],
    };
  }

  const past = [...state.past, state.present];
  const trimmed = past.length > options.limit ? past.slice(past.length - options.limit) : past;

  return {
    present: { label, document },
    past: trimmed,
    future: [],
  };
}

/**
 * Opens a coalescing scope.
 *
 * The first commit inside the gesture must still push, or the state the gesture started
 * from would be lost and undo would jump past it. So the gesture pushes a boundary entry
 * immediately and marks itself open; subsequent commits replace.
 */
export function beginGesture<TDocument>(
  state: HistoryState<TDocument>,
  label: string,
  options: HistoryOptions = { limit: DEFAULT_HISTORY_LIMIT },
): HistoryState<TDocument> {
  if (state.openGesture !== undefined) {
    // Nested gestures are a caller bug, but throwing mid-drag would be worse than
    // treating the outer scope as authoritative.
    return state;
  }
  const past = [...state.past, state.present];
  const trimmed = past.length > options.limit ? past.slice(past.length - options.limit) : past;
  return {
    present: { label, document: state.present.document },
    past: trimmed,
    future: [],
    openGesture: label,
  };
}

/**
 * Closes a coalescing scope.
 *
 * A gesture that never changed the document (a click that selected but moved nothing)
 * leaves an entry identical to the one below it, which would make undo appear to do
 * nothing. Those are dropped here.
 */
export function endGesture<TDocument>(state: HistoryState<TDocument>): HistoryState<TDocument> {
  if (state.openGesture === undefined) return state;

  const previous = state.past[state.past.length - 1];
  if (previous !== undefined && previous.document === state.present.document) {
    return {
      present: previous,
      past: state.past.slice(0, -1),
      future: state.future,
    };
  }

  return { present: state.present, past: state.past, future: state.future };
}

export function canUndo<TDocument>(state: HistoryState<TDocument>): boolean {
  return state.past.length > 0;
}

export function canRedo<TDocument>(state: HistoryState<TDocument>): boolean {
  return state.future.length > 0;
}

export function undo<TDocument>(state: HistoryState<TDocument>): HistoryState<TDocument> {
  const previous = state.past[state.past.length - 1];
  if (previous === undefined) return state;
  return {
    present: previous,
    past: state.past.slice(0, -1),
    future: [state.present, ...state.future],
  };
}

export function redo<TDocument>(state: HistoryState<TDocument>): HistoryState<TDocument> {
  const next = state.future[0];
  if (next === undefined) return state;
  return {
    present: next,
    past: [...state.past, state.present],
    future: state.future.slice(1),
  };
}

/** Label of the step undo would revert, for a menu item like "Undo Move clip". */
export function undoLabel<TDocument>(state: HistoryState<TDocument>): string | undefined {
  return canUndo(state) ? state.present.label : undefined;
}

/** Label of the step redo would reapply. */
export function redoLabel<TDocument>(state: HistoryState<TDocument>): string | undefined {
  return state.future[0]?.label;
}

/** Drops all history, keeping the current document. Used after a successful save-as. */
export function clearHistory<TDocument>(state: HistoryState<TDocument>): HistoryState<TDocument> {
  return { present: state.present, past: [], future: [] };
}
