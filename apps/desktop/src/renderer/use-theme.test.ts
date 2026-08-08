import { describe, expect, it } from 'vitest';
import { initialTheme } from './use-theme.js';

/**
 * Which theme a session starts in.
 *
 * The rule is short and the reason is not: a stored choice wins, and with none the answer is dark —
 * not the system's preference. Every other application should inherit the desktop's; this one has a
 * reason not to, and it is the same reason dark is the default at all.
 */

describe('the starting theme', () => {
  it('honours a stored choice', () => {
    expect(initialTheme('light')).toBe('light');
    expect(initialTheme('dark')).toBe('dark');
  });

  it('starts dark with no choice made, whatever the desktop prefers', () => {
    // A first run on a light-themed desktop would otherwise put the user in the wrong environment
    // for the one judgement this tool exists to support.
    expect(initialTheme(null)).toBe('dark');
    expect(initialTheme(undefined)).toBe('dark');
  });

  it('ignores a stored value that means nothing', () => {
    // A hand-edited or half-written preference must not leave the window unstyled.
    expect(initialTheme('purple')).toBe('dark');
    expect(initialTheme('')).toBe('dark');
  });
});
