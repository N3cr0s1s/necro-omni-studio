import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  THEME_CSS_BEGIN,
  THEME_CSS_END,
  replaceThemeRegion,
  themeBlocks,
  themeCss,
  themeRegion,
} from './theme-css.js';
import { THEMES } from './themes.js';

/**
 * The stylesheet, pinned to the data.
 *
 * Themes exist twice by design — as TypeScript that can be measured and iterated, and as CSS the
 * browser can cascade — and two copies of anything drift. This is the pin: the region between the
 * markers in `globals.css` is rebuilt from `THEMES` and compared. Adding a theme without regenerating
 * fails here rather than shipping a picker with an entry that does nothing.
 *
 * The same shape as the RLE codec's fixture, which is implemented twice in two languages and pinned to
 * one file for exactly this reason.
 */

const GLOBALS = new URL('../styles/globals.css', import.meta.url).pathname;

describe('a theme as CSS', () => {
  const theme = THEMES[0];

  it('selects the light appearance on the attribute alone', () => {
    expect(themeBlocks(theme!)).toContain(`[data-theme='${theme!.id}'] {`);
  });

  it('puts the dark class on the same element, with no space', () => {
    // Both land on `<html>`: the appearance from next-themes, the palette from settings. A descendant
    // combinator would match nothing while reading as correct.
    expect(themeBlocks(theme!)).toContain(`.dark[data-theme='${theme!.id}'] {`);
    expect(themeBlocks(theme!)).not.toContain('.dark [data-theme=');
  });

  it('writes every role in both appearances', () => {
    const block = themeBlocks(theme!);
    expect(block.match(/--background:/g)).toHaveLength(2);
    expect(block.match(/--sidebar-ring:/g)).toHaveLength(2);
  });
});

describe('the generated region', () => {
  it('is what the data says it should be', () => {
    const region = themeRegion(readFileSync(GLOBALS, 'utf8'));
    expect(region).toBe(themeCss(THEMES));
  });

  it('holds every theme the picker offers', () => {
    const css = readFileSync(GLOBALS, 'utf8');
    for (const theme of THEMES) expect(css).toContain(`[data-theme='${theme.id}']`);
  });

  it('leaves the stylesheet own :root and .dark untouched', () => {
    // The reason this is safe to add: a build that never sets the attribute renders exactly what it
    // rendered before.
    const css = readFileSync(GLOBALS, 'utf8');
    expect(css.indexOf(':root {')).toBeLessThan(css.indexOf(THEME_CSS_BEGIN));
    expect(css.indexOf('.dark {')).toBeLessThan(css.indexOf(THEME_CSS_BEGIN));
  });
});

describe('replacing it', () => {
  it('keeps everything outside the markers', () => {
    const css = `before\n${THEME_CSS_BEGIN}\nold\n${THEME_CSS_END}\nafter`;
    const next = replaceThemeRegion(css, 'new');
    expect(next).toBe(`before\n${THEME_CSS_BEGIN}\nnew\n${THEME_CSS_END}\nafter`);
  });

  it('refuses a stylesheet with no region rather than appending one', () => {
    // Appending would write a second copy of every theme into a file someone has edited in a way this
    // cannot reason about.
    expect(replaceThemeRegion('no markers here', 'new')).toBeUndefined();
    expect(replaceThemeRegion(`${THEME_CSS_END}\n${THEME_CSS_BEGIN}`, 'new')).toBeUndefined();
  });

  it('reads back what it wrote', () => {
    const css = `${THEME_CSS_BEGIN}\nold\n${THEME_CSS_END}`;
    expect(themeRegion(replaceThemeRegion(css, 'fresh')!)).toBe('fresh');
  });
});
