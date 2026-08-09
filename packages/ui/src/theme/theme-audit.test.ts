import { describe, expect, it } from 'vitest';
import type { Theme, ThemePalette } from './palette.js';
import { auditTheme, describeFault } from './theme-audit.js';
import { THEMES } from './themes.js';

/**
 * The audit, run against palettes that are wrong on purpose.
 *
 * `themes.test.ts` asserts that every shipped theme is clean — which is exactly the assertion that
 * passes just as happily when the audit has stopped looking. So each fault it claims to find is
 * produced here deliberately, by breaking one role of a palette that is otherwise known good.
 *
 * The same discipline as the harnesses in this repository: every new check is run once against a
 * deliberately broken build before it is trusted.
 */

/** A theme known to be clean, used as the base every mutant is one edit away from. */
const GOOD = THEMES.find((theme) => theme.id === 'zinc')!;

function withRole(theme: Theme, mode: 'light' | 'dark', role: string, value: string): Theme {
  return { ...theme, [mode]: { ...theme[mode], [role]: value } as ThemePalette };
}

describe('a clean palette', () => {
  it('has nothing to report', () => {
    expect(auditTheme(GOOD)).toEqual([]);
  });
});

describe('a role that is not a colour', () => {
  it('is reported, once, naming the role', () => {
    const faults = auditTheme(withRole(GOOD, 'light', 'ring', '#ff0000'));
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ kind: 'unreadable-role', mode: 'light', role: 'ring' });
  });

  it('is reported when it is missing entirely', () => {
    const faults = auditTheme(withRole(GOOD, 'dark', 'sidebar-ring', ''));
    expect(faults.some((f) => f.kind === 'unreadable-role' && f.role === 'sidebar-ring')).toBe(true);
  });

  it('is not also counted as every contrast pair it appears in', () => {
    // A typo in `background` would otherwise be reported five more times, in language that says
    // nothing about the typo.
    const faults = auditTheme(withRole(GOOD, 'light', 'background', 'nonsense'));
    expect(faults.filter((f) => f.kind === 'low-contrast')).toEqual([]);
  });
});

describe('text that cannot be read', () => {
  it('is caught when a foreground collapses into its surface', () => {
    const faults = auditTheme(withRole(GOOD, 'dark', 'card-foreground', GOOD.dark.card));
    const low = faults.filter((f) => f.kind === 'low-contrast');
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ foreground: 'card-foreground', background: 'card', ratio: 1 });
  });

  it('is caught in the appearance it happens in, and not the other', () => {
    const faults = auditTheme(withRole(GOOD, 'light', 'primary-foreground', GOOD.light.primary));
    expect(faults.every((f) => f.mode === 'light')).toBe(true);
  });

  it('holds the quieter roles to the lower bar rather than to no bar', () => {
    // `muted-foreground` at 2:1 is a real problem and would pass a check that simply excluded it.
    const faults = auditTheme(withRole(GOOD, 'light', 'muted-foreground', 'oklch(0.75 0 0)'));
    expect(faults.some((f) => f.kind === 'low-contrast' && f.foreground === 'muted-foreground')).toBe(true);
  });

  it('says the ratio and the bar, so the fix is a number and not a guess', () => {
    const faults = auditTheme(withRole(GOOD, 'dark', 'card-foreground', GOOD.dark.card));
    expect(describeFault(faults[0]!)).toContain('1.00:1, needs 4.5:1');
  });
});

describe('categories that cannot be told apart', () => {
  it('is caught when two chart roles hold the same colour', () => {
    const faults = auditTheme(withRole(GOOD, 'light', 'chart-3', GOOD.light['chart-2']));
    const indistinct = faults.filter((f) => f.kind === 'indistinct-categories');
    expect(indistinct).toHaveLength(1);
    expect(indistinct[0]).toMatchObject({ roles: ['chart-2', 'chart-3'], distance: 0 });
  });

  it('compares every pair, not only neighbours in the list', () => {
    // A ramp ordered by hue has no meaningful neighbours, and in shadcn's colourful ramps the closest
    // pair is `chart-1`/`chart-4` — two entries apart.
    const faults = auditTheme(withRole(GOOD, 'dark', 'chart-5', GOOD.dark['chart-1']));
    expect(
      faults.some(
        (f) => f.kind === 'indistinct-categories' && f.roles[0] === 'chart-1' && f.roles[1] === 'chart-5',
      ),
    ).toBe(true);
  });

  it('does not fire on two colours that differ only in hue', () => {
    /*
     * The reason this check measures OKLab distance and not contrast. An orange and a teal of equal
     * brightness score 1.02:1 — indistinguishable by WCAG, obvious to anyone looking. Measured the
     * wrong way, every colourful ramp shadcn publishes fails.
     */
    const shifted = withRole(GOOD, 'light', 'chart-3', 'oklch(0.6 0.118 184.704)');
    const both = withRole(shifted, 'light', 'chart-2', 'oklch(0.646 0.222 41.116)');
    expect(auditTheme(both).filter((f) => f.kind === 'indistinct-categories')).toEqual([]);
  });
});

describe('reporting', () => {
  it('returns every fault rather than stopping at the first', () => {
    // Four problems should be one sitting, not four rounds of the same conversation.
    const one = withRole(GOOD, 'light', 'card-foreground', GOOD.light.card);
    const two = withRole(one, 'dark', 'chart-2', GOOD.dark['chart-1']);
    expect(auditTheme(two).length).toBeGreaterThanOrEqual(2);
  });
});
