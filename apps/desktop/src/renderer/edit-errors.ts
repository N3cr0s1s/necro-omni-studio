import type { EditError } from '@nos/editing';

/**
 * A rejection, in words a user can act on.
 *
 * Deliberately *not* `@nos/editing`'s own `describeEditError`. That one is exhaustive over `EditError`
 * and **throws** on a kind it does not know, which is right for a domain that wants a compile error
 * when a case is added — and wrong for the shell, which hands it transition errors and segmentation
 * errors too. A message that throws turns a refused edit into a blank window.
 *
 * The wording is the shell's as well as the tolerance. These are read in a one-line status bar while
 * the user is still holding the pointer, so they say what was refused and, where there is one, what
 * would make it work. The domain's are written for a log and name ids: `Clip c1 no longer exists` is
 * the right sentence in a stack trace and the wrong one under a timeline.
 *
 * Every kind the editing package declares is spelled out here. Nine of them used to fall through to
 * the default and reach the status bar as `the edit was rejected: nothing to cut` — the discriminant
 * with its hyphens taken out, which reads as debug output and tells the user nothing about what to do
 * differently.
 */
export function describeEditError(error: { readonly kind: string }): string {
  /*
   * `kind` alone in the signature, not `& Partial<EditError>`.
   *
   * The intersection narrowed `kind` straight back to the known union, so the very thing this exists
   * for — a transition's `not-adjacent`, a mask's error — would not type-check at the call site. The
   * fields are read through a cast instead, guarded by the `case` that reached them.
   */
  const at = error as Partial<Extract<EditError, { kind: 'source-exhausted' }>> &
    Partial<Extract<EditError, { kind: 'wrong-track-kind' }>> &
    Partial<Extract<EditError, { kind: 'no-free-track' }>>;

  switch (error.kind) {
    case 'collision':
      return 'that position overlaps another clip';
    case 'track-locked':
      return 'the track is locked — unlock it to change what is on it';
    case 'clip-not-found':
      return 'the clip is gone';
    case 'track-not-found':
      return 'the track is gone';
    case 'empty-result':
      return 'that would leave nothing of the clip';
    case 'source-exhausted':
      return `the source has ${String(at.available)} frames left, ${String(at.requested)} were asked for`;
    case 'wrong-track-kind':
      return `that track holds ${(at.accepts ?? []).join(' or ')} clips`;
    case 'nothing-to-cut':
      return 'there is nothing under the playhead to cut';
    case 'no-free-track':
      return `there is no free ${String(at.kindWanted)} track — add one and try again`;
    case 'duplicate-track':
      return 'a track with that id already exists';
    case 'empty-name':
      return 'a name cannot be blank';
    case 'marker-not-found':
      return 'there is no marker there';
    case 'no-shared-cut':
      return 'those clips do not meet — there is a gap between them, so there is no cut to roll';
    case 'already-linked':
      return 'that clip is already linked to another';
    default:
      // Never a throw, and never nothing. A kind this does not know — a transition's, a mask's — still
      // has to reach the status bar as something a user can repeat back.
      return `the edit was rejected: ${String(error.kind).replace(/-/g, ' ')}`;
  }
}
