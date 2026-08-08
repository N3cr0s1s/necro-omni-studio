import { describe, expect, it, vi } from 'vitest';
import { FRAME_RATES } from '../time/frame-rate.js';
import { type TimelineDocument, createDocument } from '../document/document.js';
import { projectId, sequenceId, trackId } from '../document/ids.js';
import { ok } from '../lang/result.js';
import { createDocumentStore } from './store.js';
import {
  AUTOSAVE_INTERVAL_MS,
  type Clock,
  type DocumentPersistence,
  createAutosaveController,
  evaluateRecovery,
} from './autosave.js';

function makeDocument(name = 'breakdown_v3'): TimelineDocument {
  return createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name,
    frameRate: FRAME_RATES.NTSC_29_97,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
}

/** A clock whose interval fires only when the test says so. */
function createTestClock(): Clock & { tick(): void; advance(ms: number): void } {
  let now = 0;
  const handlers = new Set<() => void>();
  return {
    now: () => now,
    setInterval(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    tick() {
      for (const handler of [...handlers]) handler();
    },
    advance(ms) {
      now += ms;
    },
  };
}

function createTestPersistence(): DocumentPersistence & {
  readonly recoveryWrites: TimelineDocument[];
} {
  const recoveryWrites: TimelineDocument[] = [];
  return {
    recoveryWrites,
    save: async () => ok(undefined),
    saveRecovery: async (document) => {
      recoveryWrites.push(document);
      return ok(undefined);
    },
    clearRecovery: async () => ok(undefined),
  };
}

const rename = (name: string) => (document: TimelineDocument) => ({ ...document, name });

describe('createAutosaveController', () => {
  it('uses the 30 second interval the spec fixes', () => {
    expect(AUTOSAVE_INTERVAL_MS).toBe(30_000);
  });

  it('writes nothing while the document is clean', async () => {
    const store = createDocumentStore(makeDocument());
    const persistence = createTestPersistence();
    const clock = createTestClock();
    const controller = createAutosaveController(store, persistence, clock);

    controller.start();
    clock.tick();
    await controller.flush();

    expect(persistence.recoveryWrites).toHaveLength(0);
    expect(controller.getStatus().state).toBe('idle');
  });

  it('writes a recovery file once the document is dirty', async () => {
    const store = createDocumentStore(makeDocument());
    const persistence = createTestPersistence();
    const clock = createTestClock();
    const controller = createAutosaveController(store, persistence, clock);
    controller.start();

    store.commit('Rename', rename('changed'));
    clock.advance(30_000);
    await controller.flush();

    expect(persistence.recoveryWrites).toHaveLength(1);
    expect(persistence.recoveryWrites[0]!.name).toBe('changed');
    expect(controller.getStatus().state).toBe('saved');
    expect(controller.getStatus().lastSavedAt).toBe(30_000);
  });

  it('never autosaves mid-gesture, so a crash cannot recover a half-finished drag', async () => {
    const store = createDocumentStore(makeDocument());
    const persistence = createTestPersistence();
    const clock = createTestClock();
    const controller = createAutosaveController(store, persistence, clock);
    controller.start();

    store.beginGesture('Move clip');
    store.commit('Move clip', rename('mid-drag'));
    await controller.flush();
    expect(persistence.recoveryWrites).toHaveLength(0);

    store.endGesture();
    await controller.flush();
    expect(persistence.recoveryWrites).toHaveLength(1);
    expect(persistence.recoveryWrites[0]!.name).toBe('mid-drag');
  });

  it('stops writing after stop()', async () => {
    const store = createDocumentStore(makeDocument());
    const persistence = createTestPersistence();
    const clock = createTestClock();
    const controller = createAutosaveController(store, persistence, clock);

    controller.start();
    controller.stop();
    store.commit('Rename', rename('changed'));
    clock.tick();

    expect(persistence.recoveryWrites).toHaveLength(0);
  });

  it('surfaces a failure in the status without interrupting editing, and retries', async () => {
    const store = createDocumentStore(makeDocument());
    const clock = createTestClock();
    let failNext = true;
    const persistence: DocumentPersistence = {
      save: async () => ok(undefined),
      saveRecovery: async () => {
        if (failNext) {
          failNext = false;
          return { ok: false, error: { kind: 'io', message: 'disk full' } } as const;
        }
        return ok(undefined);
      },
      clearRecovery: async () => ok(undefined),
    };
    const controller = createAutosaveController(store, persistence, clock);
    controller.start();

    store.commit('Rename', rename('changed'));
    await controller.flush();

    expect(controller.getStatus().state).toBe('failed');
    expect(controller.getStatus().error).toEqual({ kind: 'io', message: 'disk full' });

    // The next tick retries rather than giving up for the session.
    await controller.flush();
    expect(controller.getStatus().state).toBe('saved');
  });

  it('notifies status subscribers', async () => {
    const store = createDocumentStore(makeDocument());
    const persistence = createTestPersistence();
    const clock = createTestClock();
    const controller = createAutosaveController(store, persistence, clock);
    const listener = vi.fn();
    controller.subscribe(listener);

    store.commit('Rename', rename('changed'));
    await controller.flush();

    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls.at(-1)![0].state).toBe('saved');
  });

  it('does not queue overlapping writes on a slow disk', async () => {
    const store = createDocumentStore(makeDocument());
    const clock = createTestClock();
    let inProgress = 0;
    let maxConcurrent = 0;
    const persistence: DocumentPersistence = {
      save: async () => ok(undefined),
      saveRecovery: async () => {
        inProgress += 1;
        maxConcurrent = Math.max(maxConcurrent, inProgress);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inProgress -= 1;
        return ok(undefined);
      },
      clearRecovery: async () => ok(undefined),
    };
    const controller = createAutosaveController(store, persistence, clock);
    controller.start();
    store.commit('Rename', rename('changed'));

    clock.tick();
    clock.tick();
    clock.tick();
    await controller.flush();

    expect(maxConcurrent).toBe(1);
  });

  it('is idempotent on repeated start', () => {
    const store = createDocumentStore(makeDocument());
    const persistence = createTestPersistence();
    const clock = createTestClock();
    const controller = createAutosaveController(store, persistence, clock);

    controller.start();
    controller.start();
    store.commit('Rename', rename('changed'));
    clock.tick();

    // A second interval would have produced a second write for one tick.
    expect(persistence.recoveryWrites.length).toBeLessThanOrEqual(1);
  });
});

describe('evaluateRecovery', () => {
  it('offers nothing when no recovery file exists', () => {
    expect(evaluateRecovery({})).toEqual({ kind: 'none' });
  });

  it('offers a recovery file newer than the saved project', () => {
    const recovered = makeDocument('recovered');
    const decision = evaluateRecovery({
      recovered: { document: recovered, modifiedAt: 2000 },
      savedModifiedAt: 1000,
    });
    expect(decision).toEqual({ kind: 'offer', recovered, savedAt: 2000 });
  });

  it('ignores a stale recovery file, so good work is never offered for overwrite', () => {
    const decision = evaluateRecovery({
      recovered: { document: makeDocument('stale'), modifiedAt: 500 },
      savedModifiedAt: 1000,
    });
    expect(decision).toEqual({ kind: 'none' });
  });

  it('treats an equal timestamp as stale, since a clean save clears recovery', () => {
    const decision = evaluateRecovery({
      recovered: { document: makeDocument(), modifiedAt: 1000 },
      savedModifiedAt: 1000,
    });
    expect(decision).toEqual({ kind: 'none' });
  });

  it('offers recovery when there is no saved project at all', () => {
    const recovered = makeDocument('unsaved');
    const decision = evaluateRecovery({
      recovered: { document: recovered, modifiedAt: 42 },
    });
    expect(decision).toEqual({ kind: 'offer', recovered, savedAt: 42 });
  });
});
