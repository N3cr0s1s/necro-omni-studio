import { type TimelineDocument } from '../document/document.js';
import {
  DEFAULT_HISTORY_LIMIT,
  type HistoryOptions,
  type HistoryState,
  beginGesture,
  canRedo,
  canUndo,
  clearHistory,
  commit,
  createHistory,
  endGesture,
  redo,
  redoLabel,
  undo,
  undoLabel,
} from './history.js';

/** Produces the next document from the current one. Must not mutate its argument. */
export type DocumentMutator = (document: TimelineDocument) => TimelineDocument;

export type Unsubscribe = () => void;

/**
 * What the UI reads.
 *
 * A single immutable snapshot object rather than individual getters, so a React
 * subscription can compare one reference to decide whether to re-render instead of
 * diffing a handful of fields.
 */
export interface StoreSnapshot {
  readonly document: TimelineDocument;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | undefined;
  readonly redoLabel: string | undefined;
  /** True when the document differs from what was last persisted. */
  readonly dirty: boolean;
  /** Whether a coalescing gesture is currently open. */
  readonly gestureOpen: boolean;
}

/**
 * The single mutation point for the document.
 *
 * Every edit — an inspector field, a timeline drag, a generator importing its output —
 * goes through `commit` or `transaction`. Nothing else may hold a mutable reference to
 * the document. That is what makes undo, autosave and dirty tracking uniform instead of
 * something each feature has to remember to participate in.
 *
 * An interface rather than a class so tests and the manifest inspector can substitute a
 * store that records commits without persisting them.
 */
export interface DocumentStore {
  getSnapshot(): StoreSnapshot;
  getDocument(): TimelineDocument;

  /** Notified after every state change. Returns an unsubscribe handle. */
  subscribe(listener: (snapshot: StoreSnapshot) => void): Unsubscribe;

  /**
   * Applies a mutation as one undo step.
   *
   * A mutator returning the same document reference is treated as a no-op and records no
   * history entry, so an edit that changes nothing (dragging a clip back to where it
   * started) does not litter the undo stack.
   */
  commit(label: string, mutate: DocumentMutator): void;

  /**
   * Runs a gesture: every commit inside `body` collapses into one undo step.
   *
   * Prefer this over manual begin/end — it closes the gesture even if `body` throws,
   * which matters because a half-open gesture would silently swallow every later edit
   * into one history entry.
   */
  transaction(label: string, body: () => void): void;

  /** Manual gesture control, for drags whose lifetime spans separate event handlers. */
  beginGesture(label: string): void;
  endGesture(): void;

  undo(): void;
  redo(): void;

  /** Records the current document as persisted, clearing the dirty flag. */
  markSaved(): void;

  /** Replaces the document and drops history. For opening a project or reverting. */
  reset(document: TimelineDocument, label?: string): void;
}

export interface DocumentStoreOptions {
  readonly history?: HistoryOptions;
}

export function createDocumentStore(
  initial: TimelineDocument,
  options: DocumentStoreOptions = {},
): DocumentStore {
  const historyOptions = options.history ?? { limit: DEFAULT_HISTORY_LIMIT };

  let history: HistoryState<TimelineDocument> = createHistory(initial);
  let savedDocument: TimelineDocument = initial;
  let snapshot: StoreSnapshot = buildSnapshot(history, savedDocument);
  const listeners = new Set<(snapshot: StoreSnapshot) => void>();

  function publish(): void {
    snapshot = buildSnapshot(history, savedDocument);
    // Copy before iterating: a listener may unsubscribe itself in response.
    for (const listener of [...listeners]) listener(snapshot);
  }

  return {
    getSnapshot: () => snapshot,
    getDocument: () => history.present.document,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    commit(label, mutate) {
      const current = history.present.document;
      const next = mutate(current);
      if (next === current) return;
      history = commit(history, next, label, historyOptions);
      publish();
    },

    transaction(label, body) {
      history = beginGesture(history, label, historyOptions);
      publish();
      try {
        body();
      } finally {
        history = endGesture(history);
        publish();
      }
    },

    beginGesture(label) {
      history = beginGesture(history, label, historyOptions);
      publish();
    },

    endGesture() {
      history = endGesture(history);
      publish();
    },

    undo() {
      if (!canUndo(history)) return;
      history = undo(history);
      publish();
    },

    redo() {
      if (!canRedo(history)) return;
      history = redo(history);
      publish();
    },

    markSaved() {
      savedDocument = history.present.document;
      publish();
    },

    reset(document, label = 'Open project') {
      history = clearHistory(createHistory(document, label));
      savedDocument = document;
      publish();
    },
  };
}

function buildSnapshot(
  history: HistoryState<TimelineDocument>,
  saved: TimelineDocument,
): StoreSnapshot {
  return {
    document: history.present.document,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undoLabel: undoLabel(history),
    redoLabel: redoLabel(history),
    // Reference equality is sound because every edit produces a new document object.
    dirty: history.present.document !== saved,
    gestureOpen: history.openGesture !== undefined,
  };
}
