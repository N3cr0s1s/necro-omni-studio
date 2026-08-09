import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AutosaveStatus,
  type Clock,
  type DocumentPersistence,
  type DocumentStore,
  type RecoveryDecision,
  type TimelineDocument,
  createAutosaveController,
  err,
  evaluateRecovery,
  loadDocument,
  ok,
  saveDocument,
} from '@nos/core';
import type { DesktopBridge } from '../main/ipc-contract.js';

/**
 * Autosave and crash recovery, wired to the desktop bridge.
 *
 * The policy — write only when dirty and no gesture is open, never touch `project.json`, offer a
 * recovery file only when it is newer than the saved project — lives in `@nos/core` and is tested
 * there against a fake clock. This is the half that could not live in a package that must stay free
 * of I/O: the persistence seam over IPC, and the decision the user is shown on launch.
 *
 * The spec asks for a 30 s autosave with crash recovery. Losing an afternoon's work is the one
 * failure an editor cannot apologise its way out of, which is why the recovery file is a *sibling*:
 * an autosave that overwrote `project.json` would destroy the last state the user deliberately saved
 * the moment they started experimenting.
 */

export interface Autosave {
  readonly status: AutosaveStatus;
  /** Work found from a session that did not exit cleanly, awaiting the user's decision. */
  readonly offer: TimelineDocument | undefined;
  /** When that work was written, for a message the user can judge. */
  readonly offeredAt: number | undefined;
  /** Adopts the recovered document. It becomes an ordinary unsaved edit. */
  accept(): void;
  /** Throws the recovered work away and removes the file. */
  discard(): void;
  /** Forces a write now — before an export, or on the way out. */
  flush(): Promise<void>;
  /** Removes the recovery file, which an explicit save has just made redundant. */
  clear(): Promise<void>;
}

export interface AutosaveOptions {
  readonly store: DocumentStore;
  /** Absent until a project is open; autosave has nowhere to write before then. */
  readonly projectRoot: string | undefined;
  readonly bridge: DesktopBridge | undefined;
  readonly intervalMs?: number;
}

export function useAutosave(options: AutosaveOptions): Autosave {
  const { store, projectRoot, bridge, intervalMs } = options;
  const [status, setStatus] = useState<AutosaveStatus>({ state: 'idle' });
  const [decision, setDecision] = useState<RecoveryDecision>({ kind: 'none' });

  const persistence = useMemo(() => (bridge === undefined ? undefined : bridgePersistence(bridge)), [bridge]);

  const controller = useMemo(() => {
    if (persistence === undefined || projectRoot === undefined) return undefined;
    return createAutosaveController(
      store,
      persistence,
      browserClock,
      intervalMs === undefined ? {} : { intervalMs },
    );
  }, [store, persistence, projectRoot, intervalMs]);

  useEffect(() => {
    if (controller === undefined) return;
    const unsubscribe = controller.subscribe(setStatus);
    controller.start();
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller]);

  // Looked for once per project, on open. A recovery file that appears later belongs to another
  // window editing the same folder, and stealing its work would be worse than ignoring it.
  useEffect(() => {
    if (bridge === undefined || projectRoot === undefined) {
      setDecision({ kind: 'none' });
      return;
    }
    let cancelled = false;

    void bridge.loadRecovery().then((snapshot) => {
      if (cancelled) return;
      if (snapshot === undefined) {
        setDecision({ kind: 'none' });
        return;
      }

      const parsed = loadDocument(snapshot.contents);
      if (!parsed.ok) {
        // A recovery file that cannot be read is not offered and not deleted. Deleting it would
        // destroy the only copy of work the user might still salvage by hand.
        setDecision({ kind: 'none' });
        return;
      }

      setDecision(
        evaluateRecovery({
          recovered: { document: parsed.value.document, modifiedAt: snapshot.modifiedAt },
          ...(snapshot.projectModifiedAt !== undefined
            ? { savedModifiedAt: snapshot.projectModifiedAt }
            : {}),
        }),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [bridge, projectRoot]);

  const accept = useCallback(() => {
    if (decision.kind !== 'offer') return;
    /*
     * Reset rather than commit: the recovered document *is* the session's starting point, and stacking
     * it on the history of a document the user never saw would make undo nonsense.
     *
     * But **not saved**. It is unwritten work by definition — that is why it was in a recovery file —
     * and marking it saved told the editor an unwritten document was safe: nothing to autosave, no
     * prompt on close, and the recovered work lost on the next quit. Restoring it has to leave the
     * project dirty, exactly as the edits that produced it did.
     */
    store.reset(decision.recovered, { saved: false });
    setDecision({ kind: 'none' });
  }, [decision, store]);

  const discard = useCallback(() => {
    setDecision({ kind: 'none' });
    void bridge?.clearRecovery();
  }, [bridge]);

  const flush = useCallback(async () => {
    await controller?.flush();
  }, [controller]);

  const clear = useCallback(async () => {
    await bridge?.clearRecovery();
  }, [bridge]);

  return {
    status,
    offer: decision.kind === 'offer' ? decision.recovered : undefined,
    offeredAt: decision.kind === 'offer' ? decision.savedAt : undefined,
    accept,
    discard,
    flush,
    clear,
  };
}

/**
 * The persistence seam over the bridge.
 *
 * `save` is present because the interface defines it, but autosave never calls it — the controller
 * only ever writes the recovery sibling. Wiring it to the real save keeps the seam honest for a
 * caller that does want it, rather than leaving a method that throws.
 */
export function bridgePersistence(bridge: DesktopBridge): DocumentPersistence {
  return {
    async save(document) {
      try {
        await bridge.saveProject(saveDocument(document));
        return ok(undefined);
      } catch (error) {
        return err({ kind: 'io', message: describe(error) });
      }
    },
    async saveRecovery(document) {
      try {
        await bridge.saveRecovery(saveDocument(document));
        return ok(undefined);
      } catch (error) {
        return err({ kind: 'io', message: describe(error) });
      }
    },
    async clearRecovery() {
      try {
        await bridge.clearRecovery();
        return ok(undefined);
      } catch (error) {
        return err({ kind: 'io', message: describe(error) });
      }
    },
  };
}

const browserClock: Clock = {
  now: () => Date.now(),
  setInterval(handler, ms) {
    const id = globalThis.setInterval(handler, ms);
    return () => globalThis.clearInterval(id);
  },
};

/**
 * How stale the last good recovery point is.
 *
 * Reported in whole seconds and minutes rather than as a timestamp: the question a user asks looking
 * at this chip is "how much would I lose", and an answer they have to subtract is not one.
 */
export function describeAutosave(status: AutosaveStatus, now = Date.now()): string {
  if (status.state === 'failed') {
    return status.lastSavedAt === undefined
      ? 'autosave failed'
      : `autosave failed · last ${elapsed(now - status.lastSavedAt)} ago`;
  }
  if (status.state === 'saving') return 'autosaving…';
  if (status.lastSavedAt === undefined) return 'autosave ready';
  return `autosaved ${elapsed(now - status.lastSavedAt)} ago`;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
