import { useCallback, useEffect, useState } from 'react';

/**
 * Light or dark.
 *
 * Dark is the default and stays the default: this is an editor whose job is judging picture, and a
 * bright surround changes what a grade looks like. Light exists because a tool nobody can use in a
 * bright room is not serving anyone — the choice is the user's, and the reason for the default is
 * not a reason to withhold it.
 *
 * Applied as an attribute on the document element rather than by swapping a stylesheet, because the
 * palette is CSS variables: one attribute changes every colour in the window at once, with no
 * flash and nothing to keep in sync.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'nos.theme';
const ATTRIBUTE = 'data-nos-theme';

export interface ThemeChoice {
  readonly theme: Theme;
  set(theme: Theme): void;
  toggle(): void;
}

/**
 * The theme a session should start in.
 *
 * A stored choice wins, and with none the answer is **dark** — deliberately, and not by following the
 * system. Every other application should inherit the desktop's preference; this one has a reason not
 * to, and it is the same reason dark is the default at all: a bright surround changes what a graded
 * frame looks like, so a first run on a light-themed desktop would put the user in the wrong
 * environment for the one judgement this tool exists to support. The switch is one click away, and a
 * choice made there is remembered forever after.
 */
export function initialTheme(stored: string | null | undefined): Theme {
  return stored === 'light' ? 'light' : 'dark';
}

export function useTheme(): ThemeChoice {
  const [theme, setTheme] = useState<Theme>(() =>
    initialTheme(globalThis.localStorage?.getItem(STORAGE_KEY)),
  );

  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (root === undefined) return;
    // Only light is stamped. Dark is what the stylesheet declares at `:root`, so writing the
    // attribute for it would put the default in two places and let them disagree.
    if (theme === 'light') root.setAttribute(ATTRIBUTE, 'light');
    else root.removeAttribute(ATTRIBUTE);

    globalThis.localStorage?.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const set = useCallback((next: Theme) => setTheme(next), []);
  const toggle = useCallback(() => setTheme((current) => (current === 'dark' ? 'light' : 'dark')), []);

  return { theme, set, toggle };
}
