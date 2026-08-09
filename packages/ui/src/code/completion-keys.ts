/**
 * Which keys drive the completion list — issue #31.
 *
 * Pure, and separate from the editor, because this is the part that is easy to get subtly wrong and
 * impossible to notice: `Tab` accepting when the list is open but indenting when it is not, `Escape`
 * closing the list rather than doing whatever `Escape` otherwise does. Deciding it in a function makes
 * every one of those a sentence in a test instead of a thing someone has to remember to try.
 */

export type CompletionCommand =
  /** Ask for suggestions where the caret is. */
  | 'open'
  | 'accept'
  | 'next'
  | 'previous'
  | 'close'
  /** Not ours — the editor handles it normally. */
  | 'none';

export interface CompletionKey {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

export function completionCommand(event: CompletionKey, open: boolean): CompletionCommand {
  // The editor's own convention and every other editor's: Ctrl+Space asks, whether or not a list is
  // already up. On macOS the same chord is reached with Meta.
  if (event.key === ' ' && (event.ctrlKey === true || event.metaKey === true)) return 'open';

  if (!open) return 'none';

  switch (event.key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Enter':
    case 'Tab':
      return 'accept';
    case 'Escape':
      return 'close';
    default:
      // Everything else types. Notably the arrow keys *left* and *right*, which move the caret and so
      // change what is being completed — the editor recomputes rather than closing, because a list
      // that vanished when you stepped back one character to fix a typo would be infuriating.
      return 'none';
  }
}

/**
 * The next highlighted index, wrapping.
 *
 * Wrapping rather than stopping: the list is short and the alternative is a key that silently does
 * nothing at the ends, which reads as the list having frozen.
 */
export function cycle(active: number, count: number, step: number): number {
  if (count <= 0) return 0;
  return (((active + step) % count) + count) % count;
}

/**
 * Whether typing a character should open the list on its own.
 *
 * Only inside a word or immediately after the punctuation that starts one, so ordinary typing in a
 * string value does not put a popup over the text on every keystroke. The explicit chord is always
 * available, and a suggestion nobody asked for is worse than one that has to be asked for.
 */
export function opensOnTyping(character: string): boolean {
  return /[A-Za-z_"]/u.test(character);
}
