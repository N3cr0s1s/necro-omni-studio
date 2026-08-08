import { type TimelineDocument } from '../document/document.js';
import { type Result } from '../lang/result.js';
import { type DocumentStore } from './store.js';

/**
 * Autosave and crash recovery.
 *
 * The spec fixes a 30 s autosave with crash recovery. The policy lives here as a
 * contract; the actual writing lives in the desktop app, because this package must stay
 * free of I/O so it can run in a worker and in tests.
 *
 * ## Why a recovery file rather than saving in place
 *
 * Autosave must never overwrite the user's `project.json` — an autosave that fires
 * mid-experiment would silently destroy the last explicitly saved state. Instead it
 * writes a sibling recovery file, and on startup a recovery file *newer* than
 * `project.json` means the previous session did not exit cleanly. The user is then
 * offered the recovered state; accepting it is an ordinary save, discarding it deletes
 * the file.
 */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/** Name of the recovery file, alongside `project.json` in the project folder. */
export const RECOVERY_FILE_NAME = 'project.recovery.json';

export type PersistError =
  | { readonly kind: 'io'; readonly message: string }
  | { readonly kind: 'serialize'; readonly message: string };

/**
 * Persistence seam.
 *
 * Everything that touches the filesystem is behind this interface, which is what lets the
 * autosave policy be unit-tested with fake clocks and an in-memory sink.
 */
export interface DocumentPersistence {
  /** Writes the authoritative `project.json`. */
  save(document: TimelineDocument): Promise<Result<void, PersistError>>;
  /** Writes the recovery sibling. Must be atomic — a torn recovery file is worse than none. */
  saveRecovery(document: TimelineDocument): Promise<Result<void, PersistError>>;
  /** Removes the recovery file after a clean save or an explicit discard. */
  clearRecovery(): Promise<Result<void, PersistError>>;
}

export interface AutosaveStatus {
  readonly state: 'idle' | 'saving' | 'saved' | 'failed';
  /** Milliseconds since the last successful autosave, for the "Autosave 12s ago" chip. */
  readonly lastSavedAt?: number;
  readonly error?: PersistError;
}

export interface AutosaveController {
  start(): void;
  stop(): void;
  /** Forces a recovery write now, e.g. just before starting a long export. */
  flush(): Promise<void>;
  getStatus(): AutosaveStatus;
  subscribe(listener: (status: AutosaveStatus) => void): () => void;
}

/** Injected so tests can drive time deterministically instead of waiting 30 s. */
export interface Clock {
  now(): number;
  setInterval(handler: () => void, ms: number): () => void;
}

export interface AutosaveOptions {
  readonly intervalMs?: number;
}

/**
 * Drives periodic recovery writes.
 *
 * Only writes when the document is dirty *and* no gesture is open: autosaving mid-drag
 * would persist a transient state, and on a crash the user would recover the document as
 * it looked halfway through a move.
 */
export function createAutosaveController(
  store: DocumentStore,
  persistence: DocumentPersistence,
  clock: Clock,
  options: AutosaveOptions = {},
): AutosaveController {
  const intervalMs = options.intervalMs ?? AUTOSAVE_INTERVAL_MS;
  const listeners = new Set<(status: AutosaveStatus) => void>();

  let status: AutosaveStatus = { state: 'idle' };
  let cancelInterval: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;

  function setStatus(next: AutosaveStatus): void {
    status = next;
    for (const listener of [...listeners]) listener(status);
  }

  async function writeRecovery(): Promise<void> {
    const snapshot = store.getSnapshot();
    if (!snapshot.dirty || snapshot.gestureOpen) return;

    setStatus({ ...status, state: 'saving' });
    const result = await persistence.saveRecovery(snapshot.document);
    if (result.ok) {
      setStatus({ state: 'saved', lastSavedAt: clock.now() });
    } else {
      // Deliberately non-fatal and non-modal: a failed autosave must not interrupt
      // editing. It surfaces in the status chip, and the next tick retries. The previous
      // success time is carried through so the chip can still say how stale the last
      // good recovery point is, which is the number that actually matters on a failure.
      const lastSavedAt = status.lastSavedAt;
      setStatus(
        lastSavedAt === undefined
          ? { state: 'failed', error: result.error }
          : { state: 'failed', error: result.error, lastSavedAt },
      );
    }
  }

  function tick(): void {
    // Skip if the previous write has not settled, so a slow disk cannot queue writes.
    if (inFlight !== undefined) return;
    inFlight = writeRecovery().finally(() => {
      inFlight = undefined;
    });
  }

  return {
    start() {
      if (cancelInterval !== undefined) return;
      cancelInterval = clock.setInterval(tick, intervalMs);
    },
    stop() {
      cancelInterval?.();
      cancelInterval = undefined;
    },
    async flush() {
      if (inFlight !== undefined) await inFlight;
      inFlight = writeRecovery().finally(() => {
        inFlight = undefined;
      });
      await inFlight;
    },
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** What startup found on disk, and therefore what to offer the user. */
export type RecoveryDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'offer'; readonly recovered: TimelineDocument; readonly savedAt: number };

/**
 * Decides whether a recovery file represents unsaved work.
 *
 * A recovery file older than `project.json` is stale — the user saved and then exited
 * cleanly, and the file simply was not cleaned up. Offering it would invite the user to
 * overwrite good work with older state.
 */
export function evaluateRecovery(input: {
  readonly recovered?: { readonly document: TimelineDocument; readonly modifiedAt: number };
  readonly savedModifiedAt?: number;
}): RecoveryDecision {
  const recovered = input.recovered;
  if (recovered === undefined) return { kind: 'none' };
  const savedAt = input.savedModifiedAt;
  if (savedAt !== undefined && recovered.modifiedAt <= savedAt) return { kind: 'none' };
  return { kind: 'offer', recovered: recovered.document, savedAt: recovered.modifiedAt };
}
