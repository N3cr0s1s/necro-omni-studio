import { THEME_ROLES, type Theme } from './palette.js';

/**
 * The stylesheet a set of themes becomes.
 *
 * Themes are applied as CSS blocks written ahead of time rather than as custom properties set from
 * JavaScript. Three reasons, in the order they matter:
 *
 * - **Nothing flashes.** Properties assigned after mount repaint the whole window one frame late, and
 *   a window that changes colour a frame after it appears looks broken in a way no amount of
 *   correctness fixes.
 * - **The browser owns the cascade.** `.dark[data-theme="zinc"]` beats `.dark` by specificity, which
 *   is a rule with a specification behind it — as against a script that has to remember to reapply
 *   every role every time either axis moves.
 * - **It is inspectable.** A palette that is wrong can be read in devtools, which is where anyone
 *   debugging one will actually be standing.
 *
 * The cost of writing them ahead of time is that the file on disk can drift from the data, so
 * `theme-css.test.ts` rebuilds the file's generated region from `THEMES` and fails if it differs.
 */

/** The markers around the generated region of `globals.css`. Everything between them is emitted. */
export const THEME_CSS_BEGIN = '/* @generated themes — see packages/ui/src/theme/themes.ts */';
export const THEME_CSS_END = '/* @end generated themes */';

/**
 * One theme, both appearances.
 *
 * The light block is a bare attribute selector and the dark one adds `.dark` on the **same** element,
 * with no space. Both land on `<html>` — the appearance from `next-themes`, the palette from settings
 * — and a descendant combinator here would match nothing at all while looking entirely correct.
 */
export function themeBlocks(theme: Theme): string {
  return [
    `[data-theme='${theme.id}'] {`,
    ...THEME_ROLES.map((role) => `  --${role}: ${theme.light[role]};`),
    '}',
    '',
    `.dark[data-theme='${theme.id}'] {`,
    ...THEME_ROLES.map((role) => `  --${role}: ${theme.dark[role]};`),
    '}',
  ].join('\n');
}

/**
 * Every theme, in order, as the generated region's contents.
 *
 * Emitted after the stylesheet's own `:root` and `.dark`, which stay exactly as shadcn wrote them.
 * Leaving those untouched is what makes this safe to add: a build where the attribute is never set,
 * or a stored id from a build with more themes in it, renders precisely what it rendered before.
 */
export function themeCss(themes: readonly Theme[]): string {
  return themes.map(themeBlocks).join('\n\n');
}

/**
 * Replaces the generated region of a stylesheet, or reports that it has no region to replace.
 *
 * `undefined` rather than appending the markers: a stylesheet missing them has been edited in a way
 * this cannot reason about, and writing a second copy of every theme into it would be worse than
 * doing nothing.
 */
export function replaceThemeRegion(css: string, contents: string): string | undefined {
  const begin = css.indexOf(THEME_CSS_BEGIN);
  const end = css.indexOf(THEME_CSS_END);
  if (begin === -1 || end === -1 || end < begin) return undefined;

  return `${css.slice(0, begin)}${THEME_CSS_BEGIN}\n${contents}\n${css.slice(end)}`;
}

/** What is between the markers today, or `undefined` if they are not both there. */
export function themeRegion(css: string): string | undefined {
  const begin = css.indexOf(THEME_CSS_BEGIN);
  const end = css.indexOf(THEME_CSS_END);
  if (begin === -1 || end === -1 || end < begin) return undefined;

  return css.slice(begin + THEME_CSS_BEGIN.length, end).trim();
}
