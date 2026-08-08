// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DocumentStore,
  type TimelineDocument,
  FRAME_RATES,
  createDocument,
  createDocumentStore,
  frameIndex,
  projectId,
  saveDocument,
  sequenceId,
  spanFromBounds,
  trackId,
} from '@nos/core';
import type { DesktopBridge, RecoverySnapshot } from '../main/ipc-contract.js';
import { type Autosave, bridgePersistence, describeAutosave, useAutosave } from './use-autosave.js';

/**
 * Autosave as the application wires it.
 *
 * The policy is tested in `@nos/core` against a fake clock. What is tested here is everything that
 * could only be wrong at the seam: that a stale recovery file is not offered, that an unreadable one
 * is neither offered nor deleted, that accepting resets rather than stacks, and that a failed write
 * is reported without interrupting the edit.
 */

afterEach(cleanup);

function documentNamed(name: string): TimelineDocument {
  return createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name,
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
}

/** A bridge with only the methods autosave uses; anything else is a defect, not a fallback. */
function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  const unexpected = (name: string) => () => {
    throw new Error(`autosave must not call ${name}`);
  };
  return new Proxy(
    {
      saveRecovery: vi.fn(async () => undefined),
      clearRecovery: vi.fn(async () => undefined),
      loadRecovery: vi.fn(async (): Promise<RecoverySnapshot | undefined> => undefined),
      saveProject: vi.fn(async () => undefined),
      ...overrides,
    } as unknown as DesktopBridge,
    {
      get(target, property: string) {
        return (target as unknown as Record<string, unknown>)[property] ?? unexpected(property);
      },
    },
  );
}

interface Harness {
  readonly autosave: () => Autosave;
  readonly store: DocumentStore;
}

function mount(options: {
  bridge: DesktopBridge;
  store?: DocumentStore;
  projectRoot?: string | undefined;
  intervalMs?: number;
}): Harness {
  const store = options.store ?? createDocumentStore(documentNamed('current'));
  let latest: Autosave | undefined;

  function Host(): null {
    latest = useAutosave({
      store,
      projectRoot: 'projectRoot' in options ? options.projectRoot : '/tmp/project',
      bridge: options.bridge,
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    });
    return null;
  }

  render(<Host />);
  return {
    autosave: () => {
      if (latest === undefined) throw new Error('not mounted');
      return latest;
    },
    store,
  };
}

function snapshotOf(document: TimelineDocument, times: { at: number; project?: number }): RecoverySnapshot {
  return {
    contents: saveDocument(document),
    modifiedAt: times.at,
    ...(times.project !== undefined ? { projectModifiedAt: times.project } : {}),
  };
}

describe('the recovery offer', () => {
  it('offers work newer than the saved project', () => {
    const bridge = fakeBridge({
      loadRecovery: async () => snapshotOf(documentNamed('recovered'), { at: 2000, project: 1000 }),
    });
    const harness = mount({ bridge });

    return waitFor(() => {
      expect(harness.autosave().offer?.name).toBe('recovered');
      expect(harness.autosave().offeredAt).toBe(2000);
    });
  });

  it('ignores one older than the saved project', async () => {
    // The user saved and exited cleanly and the file was simply not cleaned up. Offering it invites
    // them to overwrite good work with older state.
    const bridge = fakeBridge({
      loadRecovery: async () => snapshotOf(documentNamed('stale'), { at: 1000, project: 5000 }),
    });
    const harness = mount({ bridge });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.autosave().offer).toBeUndefined();
  });

  it('offers one for a project that was never saved', async () => {
    const bridge = fakeBridge({
      loadRecovery: async () => snapshotOf(documentNamed('unsaved'), { at: 1000 }),
    });
    const harness = mount({ bridge });

    await waitFor(() => expect(harness.autosave().offer?.name).toBe('unsaved'));
  });

  it('neither offers nor deletes one it cannot read', async () => {
    // Deleting it would destroy the only copy of work the user might still salvage by hand.
    const clearRecovery = vi.fn(async () => undefined);
    const bridge = fakeBridge({
      loadRecovery: async () => ({ contents: '{ not json', modifiedAt: 2000, projectModifiedAt: 1 }),
      clearRecovery,
    });
    const harness = mount({ bridge });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.autosave().offer).toBeUndefined();
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it('asks for nothing until a project is open', async () => {
    const loadRecovery = vi.fn(async () => undefined);
    mount({ bridge: fakeBridge({ loadRecovery }), projectRoot: undefined });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadRecovery).not.toHaveBeenCalled();
  });
});

describe('deciding', () => {
  const offered = () =>
    mount({
      bridge: fakeBridge({
        loadRecovery: async () => snapshotOf(documentNamed('recovered'), { at: 2000, project: 1000 }),
      }),
    });

  it('adopts the recovered document as the session, not as an edit on top of one', async () => {
    // Stacking it on the history of a document the user never saw would make undo nonsense.
    const harness = offered();
    await waitFor(() => expect(harness.autosave().offer).toBeDefined());

    act(() => harness.autosave().accept());

    expect(harness.store.getDocument().name).toBe('recovered');
    expect(harness.store.getSnapshot().canUndo).toBe(false);
    expect(harness.autosave().offer).toBeUndefined();
  });

  it('deletes the file only when the user discards it', async () => {
    const clearRecovery = vi.fn(async () => undefined);
    const bridge = fakeBridge({
      loadRecovery: async () => snapshotOf(documentNamed('recovered'), { at: 2000, project: 1000 }),
      clearRecovery,
    });
    const harness = mount({ bridge });
    await waitFor(() => expect(harness.autosave().offer).toBeDefined());

    act(() => harness.autosave().discard());

    expect(clearRecovery).toHaveBeenCalledTimes(1);
    expect(harness.autosave().offer).toBeUndefined();
  });
});

describe('writing', () => {
  it('writes the recovery sibling and never the project file', async () => {
    const saveRecovery = vi.fn(async () => undefined);
    const saveProject = vi.fn(async () => undefined);
    const store = createDocumentStore(documentNamed('current'));
    const harness = mount({ bridge: fakeBridge({ saveRecovery, saveProject }), store });

    store.commit('edit', (current) => ({ ...current, name: 'edited' }));
    await act(async () => {
      await harness.autosave().flush();
    });

    expect(saveRecovery).toHaveBeenCalledTimes(1);
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('writes nothing when there is nothing to lose', async () => {
    // A clean document has nothing an autosave could recover, and writing anyway would keep touching
    // the file's timestamp — which is what the staleness check reads.
    const saveRecovery = vi.fn(async () => undefined);
    const harness = mount({ bridge: fakeBridge({ saveRecovery }) });

    await act(async () => {
      await harness.autosave().flush();
    });

    expect(saveRecovery).not.toHaveBeenCalled();
  });

  it('does not persist a document caught mid-gesture', async () => {
    // On a crash the user would recover the timeline as it looked halfway through a drag.
    const saveRecovery = vi.fn(async () => undefined);
    const store = createDocumentStore(documentNamed('current'));
    const harness = mount({ bridge: fakeBridge({ saveRecovery }), store });

    store.beginGesture('move clip');
    store.commit('move clip', (current) => ({ ...current, name: 'mid-drag' }));
    await act(async () => {
      await harness.autosave().flush();
    });

    expect(saveRecovery).not.toHaveBeenCalled();
  });

  it('reports a failed write without interrupting the edit', async () => {
    const store = createDocumentStore(documentNamed('current'));
    const bridge = fakeBridge({
      saveRecovery: async () => {
        throw new Error('disk full');
      },
    });
    const harness = mount({ bridge, store });

    store.commit('edit', (current) => ({ ...current, name: 'edited' }));
    await act(async () => {
      await harness.autosave().flush();
    });

    expect(harness.autosave().status.state).toBe('failed');
    expect(harness.autosave().status.error?.message).toContain('disk full');
    // The edit is untouched: a failed autosave is a status line, not an interruption.
    expect(store.getDocument().name).toBe('edited');
  });
});

describe('the persistence seam', () => {
  it('turns a thrown bridge error into a result, because a rejection here would kill the timer', async () => {
    const persistence = bridgePersistence(
      fakeBridge({
        saveRecovery: async () => {
          throw new Error('EACCES');
        },
      }),
    );

    const result = await persistence.saveRecovery(documentNamed('x'));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('io');
  });

  it('serializes through the same writer an explicit save uses', async () => {
    const saveRecovery = vi.fn(async () => undefined);
    const document = {
      ...documentNamed('x'),
      sequence: {
        ...documentNamed('x').sequence,
        workRange: spanFromBounds(frameIndex(10), frameIndex(20)),
      },
    };

    await bridgePersistence(fakeBridge({ saveRecovery })).saveRecovery(document);

    // Written through the project schema, so recovering restores everything a save would — not a
    // reduced snapshot that silently drops whatever the writer did not think to include.
    const written = (saveRecovery.mock.calls as unknown as readonly (readonly string[])[])[0]?.[0];
    expect(written).toContain('workRange');
  });
});

describe('the status line', () => {
  it('answers how much would be lost, not whether a timer is running', () => {
    expect(describeAutosave({ state: 'saved', lastSavedAt: 1000 }, 13_000)).toBe('autosaved 12s ago');
  });

  it('rounds to minutes once seconds stop being useful', () => {
    expect(describeAutosave({ state: 'saved', lastSavedAt: 0 }, 185_000)).toBe('autosaved 3m ago');
  });

  it('still says how stale the last good point is after a failure', () => {
    // The number that actually matters on a failure is how old the last recoverable state is.
    const text = describeAutosave(
      { state: 'failed', lastSavedAt: 1000, error: { kind: 'io', message: 'x' } },
      31_000,
    );
    expect(text).toBe('autosave failed · last 30s ago');
  });

  it('says so plainly when nothing has ever been written', () => {
    expect(describeAutosave({ state: 'failed', error: { kind: 'io', message: 'x' } })).toBe(
      'autosave failed',
    );
  });

  it('does not claim a save that has not happened', () => {
    expect(describeAutosave({ state: 'idle' })).toBe('autosave ready');
  });
});
