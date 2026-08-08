import { describe, expect, it, vi } from 'vitest';
import { FRAME_RATES } from '../time/frame-rate.js';
import { type TimelineDocument, createDocument } from '../document/document.js';
import { projectId, sequenceId, trackId } from '../document/ids.js';
import { type StoreSnapshot, createDocumentStore } from './store.js';

function makeDocument(name = 'breakdown_v3'): TimelineDocument {
  return createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name,
    frameRate: FRAME_RATES.NTSC_29_97,
    resolution: { width: 1920, height: 1080 },
    trackIds: {
      video: trackId('v1'),
      audio: trackId('a1'),
      text: trackId('t1'),
    },
  });
}

const rename = (name: string) => (document: TimelineDocument) => ({ ...document, name });

describe('createDocumentStore', () => {
  it('exposes the initial document as clean', () => {
    const store = createDocumentStore(makeDocument());
    const snapshot = store.getSnapshot();
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.canUndo).toBe(false);
    expect(snapshot.gestureOpen).toBe(false);
  });

  it('creates a project with V1, A1 and T1 so there is somewhere to drop media', () => {
    const document = makeDocument();
    expect(document.sequence.tracks.map((track) => track.name)).toEqual(['V1', 'A1', 'T1']);
    expect(document.sequence.tracks.map((track) => track.kind)).toEqual([
      'video',
      'audio',
      'text',
    ]);
  });
});

describe('commit', () => {
  it('applies a mutation and marks the document dirty', () => {
    const store = createDocumentStore(makeDocument());
    store.commit('Rename', rename('renamed'));

    const snapshot = store.getSnapshot();
    expect(snapshot.document.name).toBe('renamed');
    expect(snapshot.dirty).toBe(true);
    expect(snapshot.canUndo).toBe(true);
    expect(snapshot.undoLabel).toBe('Rename');
  });

  it('ignores a mutator that returns the same document, keeping the undo stack clean', () => {
    const store = createDocumentStore(makeDocument());
    const listener = vi.fn();
    store.subscribe(listener);

    store.commit('No-op', (document) => document);

    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().dirty).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers with the new snapshot', () => {
    const store = createDocumentStore(makeDocument());
    const seen: StoreSnapshot[] = [];
    store.subscribe((snapshot) => seen.push(snapshot));

    store.commit('Rename', rename('a'));
    store.commit('Rename', rename('b'));

    expect(seen).toHaveLength(2);
    expect(seen[1]!.document.name).toBe('b');
  });

  it('stops notifying after unsubscribe', () => {
    const store = createDocumentStore(makeDocument());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.commit('Rename', rename('a'));
    unsubscribe();
    store.commit('Rename', rename('b'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tolerates a listener unsubscribing itself during notification', () => {
    const store = createDocumentStore(makeDocument());
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(() => unsubscribeFirst());
    store.subscribe(second);

    expect(() => store.commit('Rename', rename('a'))).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('publishes a new snapshot object so a reference check detects the change', () => {
    const store = createDocumentStore(makeDocument());
    const before = store.getSnapshot();
    store.commit('Rename', rename('a'));
    expect(store.getSnapshot()).not.toBe(before);
  });
});

describe('undo and redo', () => {
  it('reverts and reapplies a commit', () => {
    const store = createDocumentStore(makeDocument('original'));
    store.commit('Rename', rename('changed'));

    store.undo();
    expect(store.getDocument().name).toBe('original');
    expect(store.getSnapshot().canRedo).toBe(true);

    store.redo();
    expect(store.getDocument().name).toBe('changed');
  });

  it('is a no-op at the ends and publishes nothing', () => {
    const store = createDocumentStore(makeDocument());
    const listener = vi.fn();
    store.subscribe(listener);

    store.undo();
    store.redo();

    expect(listener).not.toHaveBeenCalled();
  });

  it('clears dirty when undo returns to the saved document', () => {
    const store = createDocumentStore(makeDocument('original'));
    store.commit('Rename', rename('changed'));
    expect(store.getSnapshot().dirty).toBe(true);

    store.undo();
    expect(store.getSnapshot().dirty).toBe(false);
  });
});

describe('transaction', () => {
  it('collapses every commit inside it into one undo step', () => {
    const store = createDocumentStore(makeDocument('start'));

    store.transaction('Move clip', () => {
      store.commit('Move clip', rename('a'));
      store.commit('Move clip', rename('b'));
      store.commit('Move clip', rename('c'));
    });

    expect(store.getDocument().name).toBe('c');
    store.undo();
    expect(store.getDocument().name).toBe('start');
  });

  it('closes the gesture even when the body throws, so later edits are not swallowed', () => {
    const store = createDocumentStore(makeDocument('start'));

    expect(() =>
      store.transaction('Move clip', () => {
        store.commit('Move clip', rename('partial'));
        throw new Error('drag handler blew up');
      }),
    ).toThrow('drag handler blew up');

    expect(store.getSnapshot().gestureOpen).toBe(false);

    // A later edit must be its own undo step, not merged into the failed gesture.
    store.commit('Rename', rename('after'));
    store.undo();
    expect(store.getDocument().name).toBe('partial');
  });

  it('reports the gesture as open while the body runs', () => {
    const store = createDocumentStore(makeDocument());
    let openDuringBody = false;
    store.transaction('Move clip', () => {
      openDuringBody = store.getSnapshot().gestureOpen;
    });
    expect(openDuringBody).toBe(true);
    expect(store.getSnapshot().gestureOpen).toBe(false);
  });

  it('leaves no undo entry for a gesture that changed nothing', () => {
    const store = createDocumentStore(makeDocument());
    store.transaction('Move clip', () => {
      // A click that starts a drag and releases without moving.
    });
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it('supports manual gesture control across separate handlers', () => {
    const store = createDocumentStore(makeDocument('start'));

    store.beginGesture('Trim clip');
    store.commit('Trim clip', rename('a'));
    store.commit('Trim clip', rename('b'));
    store.endGesture();

    store.undo();
    expect(store.getDocument().name).toBe('start');
  });
});

describe('markSaved and reset', () => {
  it('clears the dirty flag without touching history', () => {
    const store = createDocumentStore(makeDocument());
    store.commit('Rename', rename('changed'));
    store.markSaved();

    const snapshot = store.getSnapshot();
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.canUndo).toBe(true);
  });

  it('goes dirty again after a further edit', () => {
    const store = createDocumentStore(makeDocument());
    store.commit('Rename', rename('a'));
    store.markSaved();
    store.commit('Rename', rename('b'));
    expect(store.getSnapshot().dirty).toBe(true);
  });

  it('reset replaces the document and drops history', () => {
    const store = createDocumentStore(makeDocument('first'));
    store.commit('Rename', rename('changed'));

    store.reset(makeDocument('second'));

    const snapshot = store.getSnapshot();
    expect(snapshot.document.name).toBe('second');
    expect(snapshot.canUndo).toBe(false);
    expect(snapshot.canRedo).toBe(false);
    expect(snapshot.dirty).toBe(false);
  });
});
