import { describe, expect, it } from 'vitest';
import { completionCommand, cycle, opensOnTyping } from './completion-keys.js';

/**
 * Which keys drive the completion list, per issue #31.
 *
 * The value of deciding this in a function is exactly what these assert: the same key means different
 * things depending on whether a list is up, and every one of those is a sentence here rather than
 * something someone has to remember to try by hand.
 */

describe('asking for suggestions', () => {
  it('is Ctrl+Space, whether or not a list is already up', () => {
    expect(completionCommand({ key: ' ', ctrlKey: true }, false)).toBe('open');
    expect(completionCommand({ key: ' ', ctrlKey: true }, true)).toBe('open');
  });

  it('is the same chord under Meta, which is where macOS puts it', () => {
    expect(completionCommand({ key: ' ', metaKey: true }, false)).toBe('open');
  });

  it('is not a plain space, which types one', () => {
    expect(completionCommand({ key: ' ' }, true)).toBe('none');
  });
});

describe('with no list open', () => {
  it('leaves every navigation key to the editor', () => {
    // Tab must indent, Escape must do whatever Escape otherwise does, and Enter must add a line.
    for (const key of ['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
      expect(completionCommand({ key }, false)).toBe('none');
    }
  });
});

describe('with a list open', () => {
  it('moves the highlight with the arrows', () => {
    expect(completionCommand({ key: 'ArrowDown' }, true)).toBe('next');
    expect(completionCommand({ key: 'ArrowUp' }, true)).toBe('previous');
  });

  it('accepts on Enter and on Tab', () => {
    expect(completionCommand({ key: 'Enter' }, true)).toBe('accept');
    expect(completionCommand({ key: 'Tab' }, true)).toBe('accept');
  });

  it('closes on Escape', () => {
    expect(completionCommand({ key: 'Escape' }, true)).toBe('close');
  });

  it('leaves the horizontal arrows alone', () => {
    // They move the caret, so the editor recomputes. A list that vanished when you stepped back one
    // character to fix a typo would be infuriating.
    expect(completionCommand({ key: 'ArrowLeft' }, true)).toBe('none');
    expect(completionCommand({ key: 'ArrowRight' }, true)).toBe('none');
  });

  it('leaves ordinary typing alone', () => {
    expect(completionCommand({ key: 'a' }, true)).toBe('none');
  });
});

describe('moving the highlight', () => {
  it('steps forward and back', () => {
    expect(cycle(0, 3, 1)).toBe(1);
    expect(cycle(2, 3, -1)).toBe(1);
  });

  it('wraps at both ends, so a key never silently does nothing', () => {
    expect(cycle(2, 3, 1)).toBe(0);
    expect(cycle(0, 3, -1)).toBe(2);
  });

  it('survives an empty list', () => {
    expect(cycle(0, 0, 1)).toBe(0);
  });
});

describe('opening as you type', () => {
  it('opens inside a word and on the quote that starts one', () => {
    expect(opensOnTyping('k')).toBe(true);
    expect(opensOnTyping('"')).toBe(true);
  });

  it('stays shut on punctuation and space', () => {
    // Otherwise a popup sits over the text on every keystroke, and a suggestion nobody asked for is
    // worse than one that has to be asked for.
    for (const character of [',', ':', ' ', '{', '\n']) {
      expect(opensOnTyping(character)).toBe(false);
    }
  });
});
