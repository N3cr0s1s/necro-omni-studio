import { describe, expect, it } from 'vitest';
import {
  type HistoryOptions,
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
  jump,
  steps,
} from './history.js';

/** A stand-in document: the history layer is generic and knows nothing about timelines. */
interface Doc {
  readonly value: number;
}

const doc = (value: number): Doc => ({ value });

describe('createHistory', () => {
  it('starts with a present and nothing to undo or redo', () => {
    const state = createHistory(doc(0));
    expect(state.present.document).toEqual(doc(0));
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
  });
});

describe('commit', () => {
  it('pushes the previous present onto the past', () => {
    let state = createHistory(doc(0));
    state = commit(state, doc(1), 'Set 1');
    expect(state.present.document).toEqual(doc(1));
    expect(state.past).toHaveLength(1);
    expect(canUndo(state)).toBe(true);
  });

  it('reports the label of the step undo would revert', () => {
    let state = createHistory(doc(0));
    expect(undoLabel(state)).toBeUndefined();
    state = commit(state, doc(1), 'Set 1');
    expect(undoLabel(state)).toBe('Set 1');
  });

  it('discards the redo branch, so redo never resurrects an abandoned future', () => {
    let state = createHistory(doc(0));
    state = commit(state, doc(1), 'Set 1');
    state = undo(state);
    expect(canRedo(state)).toBe(true);
    state = commit(state, doc(2), 'Set 2');
    expect(canRedo(state)).toBe(false);
    expect(state.present.document).toEqual(doc(2));
  });

  it('drops the oldest entries past the limit', () => {
    const options: HistoryOptions = { limit: 3 };
    let state = createHistory(doc(0));
    for (let i = 1; i <= 10; i += 1) {
      state = commit(state, doc(i), `Set ${i}`, options);
    }
    expect(state.past).toHaveLength(3);
    // The reachable history is the three most recent predecessors.
    expect(state.past.map((entry) => (entry.document as Doc).value)).toEqual([7, 8, 9]);
  });
});

describe('undo and redo', () => {
  it('walks backwards and forwards through states', () => {
    let state = createHistory(doc(0));
    state = commit(state, doc(1), 'Set 1');
    state = commit(state, doc(2), 'Set 2');

    state = undo(state);
    expect(state.present.document).toEqual(doc(1));
    state = undo(state);
    expect(state.present.document).toEqual(doc(0));
    expect(canUndo(state)).toBe(false);

    state = redo(state);
    expect(state.present.document).toEqual(doc(1));
    state = redo(state);
    expect(state.present.document).toEqual(doc(2));
    expect(canRedo(state)).toBe(false);
  });

  it('is a no-op at either end rather than throwing', () => {
    const initial = createHistory(doc(0));
    expect(undo(initial)).toBe(initial);
    expect(redo(initial)).toBe(initial);
  });

  it('reports the redo label', () => {
    let state = createHistory(doc(0));
    state = commit(state, doc(1), 'Set 1');
    state = undo(state);
    expect(redoLabel(state)).toBe('Set 1');
  });

  it('round-trips to the identical document reference, preserving structural sharing', () => {
    const original = doc(0);
    let state = createHistory(original);
    state = commit(state, doc(1), 'Set 1');
    state = undo(state);
    expect(state.present.document).toBe(original);
  });
});

describe('gesture coalescing', () => {
  it('collapses every commit in a drag into one undo step', () => {
    let state = createHistory(doc(0));
    state = beginGesture(state, 'Move clip');
    // A drag emits a commit per pointer move.
    for (const frame of [3, 7, 11, 14]) {
      state = commit(state, doc(frame), 'Move clip');
    }
    state = endGesture(state);

    expect(state.present.document).toEqual(doc(14));
    expect(state.past).toHaveLength(1);

    state = undo(state);
    expect(state.present.document).toEqual(doc(0));
  });

  it('keeps the gesture label rather than the last commit label', () => {
    let state = createHistory(doc(0));
    state = beginGesture(state, 'Move clip');
    state = commit(state, doc(5), 'intermediate position');
    state = endGesture(state);
    expect(state.present.label).toBe('Move clip');
  });

  it('preserves the pre-gesture state, so undo lands where the drag started', () => {
    let state = createHistory(doc(0));
    state = commit(state, doc(1), 'Set 1');
    state = beginGesture(state, 'Move clip');
    state = commit(state, doc(50), 'Move clip');
    state = endGesture(state);

    state = undo(state);
    expect(state.present.document).toEqual(doc(1));
  });

  it('leaves no entry for a gesture that changed nothing', () => {
    let state = createHistory(doc(0));
    state = commit(state, doc(1), 'Set 1');
    const before = state;

    // A click that begins a drag but never moves.
    state = beginGesture(state, 'Move clip');
    state = endGesture(state);

    expect(state.past).toHaveLength(before.past.length);
    expect(state.present.document).toBe(before.present.document);
    expect(state.present.label).toBe('Set 1');
  });

  it('clears redo when a gesture starts', () => {
    let state = createHistory(doc(0));
    state = commit(state, doc(1), 'Set 1');
    state = undo(state);
    state = beginGesture(state, 'Move clip');
    expect(canRedo(state)).toBe(false);
  });

  it('treats the outer scope as authoritative if a gesture is nested by mistake', () => {
    let state = createHistory(doc(0));
    state = beginGesture(state, 'Move clip');
    state = beginGesture(state, 'Trim clip');
    state = commit(state, doc(9), 'Trim clip');
    state = endGesture(state);

    expect(state.past).toHaveLength(1);
    expect(state.present.label).toBe('Move clip');
  });

  it('ignores endGesture without a matching begin', () => {
    const state = createHistory(doc(0));
    expect(endGesture(state)).toBe(state);
  });

  it('supports back-to-back gestures as separate undo steps', () => {
    let state = createHistory(doc(0));
    state = beginGesture(state, 'Move clip');
    state = commit(state, doc(5), 'Move clip');
    state = endGesture(state);
    state = beginGesture(state, 'Trim clip');
    state = commit(state, doc(8), 'Trim clip');
    state = endGesture(state);

    expect(state.past).toHaveLength(2);
    state = undo(state);
    expect(state.present.document).toEqual(doc(5));
    state = undo(state);
    expect(state.present.document).toEqual(doc(0));
  });
});

describe('clearHistory', () => {
  it('keeps the document but drops both stacks', () => {
    let state = createHistory(doc(0));
    state = commit(state, doc(1), 'Set 1');
    state = undo(state);
    state = clearHistory(state);
    expect(state.present.document).toEqual(doc(0));
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
  });
});

/*
 * The history as a list, and moving through it in one gesture.
 *
 * Undo and redo say what the *next* step in each direction is, which is enough for two buttons and not
 * enough for the question a user has after ten minutes of cutting: what did I do, and how far back is
 * the point I want? Ten presses to reach it is ten chances to overshoot.
 */
describe('reading the history', () => {
  const three = () => {
    let state = createHistory('a', 'Open project');
    state = commit(state, 'b', 'Split clip');
    state = commit(state, 'c', 'Move clip');
    return state;
  };

  it('lists every step oldest first, with the present at zero', () => {
    expect(steps(three())).toEqual([
      { label: 'Open project', offset: -2 },
      { label: 'Split clip', offset: -1 },
      { label: 'Move clip', offset: 0 },
    ]);
  });

  it('keeps undone steps on the list, ahead of now', () => {
    // They are still reachable, and a list that dropped them would make redo look like a dead button.
    expect(steps(undo(three()))).toEqual([
      { label: 'Open project', offset: -1 },
      { label: 'Split clip', offset: 0 },
      { label: 'Move clip', offset: 1 },
    ]);
  });

  it('offers one entry for a fresh document', () => {
    expect(steps(createHistory('a'))).toEqual([{ label: 'Open project', offset: 0 }]);
  });
});

describe('jumping through the history', () => {
  const three = () => {
    let state = createHistory('a', 'Open project');
    state = commit(state, 'b', 'Split clip');
    state = commit(state, 'c', 'Move clip');
    return state;
  };

  it('moves back the number of steps asked for', () => {
    expect(jump(three(), -2).present.document).toBe('a');
  });

  it('moves forward again', () => {
    expect(jump(jump(three(), -2), 2).present.document).toBe('c');
  });

  it('lands on the end rather than refusing an offset past it', () => {
    // A list built one render ago can name a step a commit in between has just dropped, and refusing
    // would leave the user pressing a row that does nothing.
    expect(jump(three(), -99).present.document).toBe('a');
    expect(jump(three(), 99).present.document).toBe('c');
  });

  it('changes nothing at zero, and returns the very same state', () => {
    const state = three();
    expect(jump(state, 0)).toBe(state);
  });

  it('leaves the redo stack intact, since jumping back is undo and not an edit', () => {
    expect(steps(jump(three(), -2)).filter((step) => step.offset > 0)).toHaveLength(2);
  });
});
