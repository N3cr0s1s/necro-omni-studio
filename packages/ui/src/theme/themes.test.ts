import { describe, expect, it } from 'vitest';
import { parseOklch } from './oklch.js';
import { THEME_ROLES } from './palette.js';
import { auditTheme, describeFault } from './theme-audit.js';
import { DEFAULT_THEME_ID, THEMES, isThemeId, themeById } from './themes.js';

/**
 * Every theme, measured.
 *
 * This is the check the whole module exists for. A palette is thirty-one strings and no amount of
 * reading them tells you whether a sentence drawn in one on another can be read — so each shipped
 * theme is converted to sRGB and held to WCAG, in both appearances, on every pair the application
 * actually draws text on.
 *
 * It runs over `THEMES` rather than over a list repeated here, so a theme added tomorrow is measured
 * without anyone remembering to add it. That is the only version of this check worth having.
 */

describe('every shipped theme', () => {
  it.each(THEMES.map((theme) => [theme.id, theme] as const))('%s answers for every role', (_id, theme) => {
    for (const mode of ['light', 'dark'] as const) {
      for (const role of THEME_ROLES) {
        const value = theme[mode][role];
        expect(value, `${theme.id}.${mode}.${role}`).toBeTruthy();
        // Readable as a colour, not merely present: a typo in a value is a role that silently
        // inherits, which is exactly the failure a palette switch is prone to.
        expect(parseOklch(value).ok, `${theme.id}.${mode}.${role} = ${value}`).toBe(true);
      }
    }
  });

  it.each(THEMES.map((theme) => [theme.id, theme] as const))('%s passes the audit', (_id, theme) => {
    /*
     * The whole legibility check, in one line, because the audit is a function and its own tests
     * prove it fails when it should. Both appearances, every text pair, every category.
     *
     * Reported as the faults themselves rather than as a count: "expected 3 to be 0" sends someone
     * hunting, and the palette is thirty-one numbers to hunt through.
     */
    expect(auditTheme(theme).map(describeFault)).toEqual([]);
  });
});

describe('the set', () => {
  it('has no two themes claiming one id', () => {
    // The id is the `data-theme` attribute and a stored setting, so a duplicate is a palette that
    // sometimes applies.
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length);
  });

  it('contains its own default', () => {
    expect(THEMES.some((theme) => theme.id === DEFAULT_THEME_ID)).toBe(true);
  });

  it('says where each palette came from', () => {
    // The one claim this file makes that nothing else can check: that no colour here was invented.
    for (const theme of THEMES) expect(theme.source.length).toBeGreaterThan(10);
  });
});

describe('looking one up', () => {
  it('finds it by id', () => {
    expect(themeById('zinc').id).toBe('zinc');
  });

  it('falls back to the default for an id this build does not have', () => {
    // A settings file written by a build with more themes in it, or edited by hand. Neither is an
    // error worth refusing to start over.
    expect(themeById('a-theme-from-next-year').id).toBe(DEFAULT_THEME_ID);
    expect(themeById(undefined).id).toBe(DEFAULT_THEME_ID);
  });

  it('recognises the ids it has and no others', () => {
    expect(isThemeId('neutral')).toBe(true);
    expect(isThemeId('chartreuse')).toBe(false);
    expect(isThemeId(7)).toBe(false);
  });
});
