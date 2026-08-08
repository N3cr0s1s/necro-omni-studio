import { useCallback, useEffect, useState } from 'react';

/**
 * A message that says something worked, and then goes away.
 *
 * Confirmations and failures were the same piece of state, so both behaved like failures: `kept —
 * Stable Audio 3 went to a new track` sat in the status bar for the rest of the session, under an
 * error icon, with no way to remove it. Two different things wanted two different lifetimes.
 *
 * A **failure** persists. It is the one message a user must not lose before reading, and it stays
 * until the thing that caused it is resolved or the user dismisses it.
 *
 * A **confirmation** answers an action the user just took, so it is only useful for as long as that
 * action is still in mind. It clears itself.
 *
 * Saying the same thing twice restarts the clock rather than being swallowed: keeping two variants in
 * a row is two confirmations, and the second one is the one the user is waiting for.
 */

export interface Confirmation {
  /** What to show, or nothing. */
  readonly message: string | undefined;
  readonly say: (message: string) => void;
  readonly clear: () => void;
}

/** How long a confirmation stays. Long enough to read a sentence, short enough not to become furniture. */
export const CONFIRMATION_HOLD_MS = 6000;

export function useConfirmation(holdMs: number = CONFIRMATION_HOLD_MS): Confirmation {
  // The token is what makes a repeat restart the timer: the message alone would be an unchanged
  // dependency, so the effect would not re-run and the second confirmation would inherit the first
  // one's remaining time.
  const [entry, setEntry] = useState<{ readonly message: string; readonly token: number } | undefined>(
    undefined,
  );

  const say = useCallback((message: string) => {
    setEntry((previous) => ({ message, token: (previous?.token ?? 0) + 1 }));
  }, []);

  const clear = useCallback(() => setEntry(undefined), []);

  useEffect(() => {
    if (entry === undefined) return;
    const timer = globalThis.setTimeout(() => setEntry(undefined), holdMs);
    return () => globalThis.clearTimeout(timer);
  }, [entry, holdMs]);

  return { message: entry?.message, say, clear };
}
