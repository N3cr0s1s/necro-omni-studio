import type { EditError } from '@nos/editing';

/**
 * A rejection, in words a user can act on.
 *
 * Deliberately *not* `@nos/editing`'s own `describeEditError`. That one is exhaustive over `EditError`
 * and **throws** on a kind it does not know, which is right for a domain that wants a compile error
 * when a case is added — and wrong for the shell, which hands it transition errors and segmentation
 * errors too. A message that throws turns a refused edit into a blank window.
 *
 * The wording is also the shell's: short, lower case, and about what the user just tried rather than
 * about which clip id was involved. It is read in a one-line status bar, not in a log.
 */
export function describeEditError(error: { readonly kind: string } & Partial<EditError>): string {
  switch (error.kind) {
    case 'collision':
      return 'that position overlaps another clip';
    case 'track-locked':
      return 'the track is locked';
    case 'clip-not-found':
      return 'the clip is gone';
    case 'empty-result':
      return 'that would leave nothing of the clip';
    case 'source-exhausted':
      return `the source has ${String((error as { available?: number }).available)} frames left, ${String(
        (error as { requested?: number }).requested,
      )} were asked for`;
    default:
      // Never a throw. A kind this does not know still has to reach the status bar as something.
      return `the edit was rejected: ${String(error.kind).replace(/-/g, ' ')}`;
  }
}
