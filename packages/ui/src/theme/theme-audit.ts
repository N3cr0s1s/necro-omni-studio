import { paletteContrast, paletteDistance } from './oklch.js';
import {
  CHART_DISTINCTNESS_MINIMUM,
  CHART_ROLES,
  SECONDARY_CONTRAST_MINIMUM,
  SECONDARY_TEXT_PAIRS,
  TEXT_CONTRAST_MINIMUM,
  TEXT_PAIRS,
  THEME_ROLES,
  type Theme,
} from './palette.js';

/**
 * Everything that can be wrong with a theme, in one pass.
 *
 * A function rather than a pile of assertions inside a test, for one reason that matters: an audit
 * that lives in a test can only ever be trusted as far as someone remembers to check that it fails
 * when it should. As a function it can be pointed at a **deliberately broken** palette, and
 * `theme-audit.test.ts` does exactly that for every fault it claims to find. A check nobody has
 * watched fail is not a check.
 *
 * It also means the audit is available to anything else that wants it — a picker that wanted to warn,
 * a harness, a future theme editor — rather than being locked inside a spec file.
 */

export type ThemeFault =
  /** A role is absent, or its value is not a colour this can read. */
  | {
      readonly kind: 'unreadable-role';
      readonly mode: Appearance;
      readonly role: string;
      readonly value: string;
    }
  /** Text that cannot be read on its own surface. */
  | {
      readonly kind: 'low-contrast';
      readonly mode: Appearance;
      readonly foreground: string;
      readonly background: string;
      readonly ratio: number;
      readonly required: number;
    }
  /** Two categories a user would have to guess between. */
  | {
      readonly kind: 'indistinct-categories';
      readonly mode: Appearance;
      readonly roles: readonly [string, string];
      readonly distance: number;
      readonly required: number;
    };

export type Appearance = 'light' | 'dark';

const APPEARANCES: readonly Appearance[] = ['light', 'dark'];

/**
 * Every fault in a theme, both appearances, in a stable order.
 *
 * All of them rather than the first: a palette with four problems should be fixed in one sitting, and
 * a check that stops at the first turns that into four rounds of the same conversation.
 */
export function auditTheme(theme: Theme): readonly ThemeFault[] {
  const faults: ThemeFault[] = [];

  for (const mode of APPEARANCES) {
    const palette = theme[mode];

    for (const role of THEME_ROLES) {
      const value = palette[role];
      // Checked before anything else uses it, so a typo is reported as a typo rather than as every
      // contrast pair the role appears in failing for no stated reason.
      if (value === undefined || !paletteContrast(value, value).ok) {
        faults.push({ kind: 'unreadable-role', mode, role, value: value ?? '' });
      }
    }

    for (const [pairs, required] of [
      [TEXT_PAIRS, TEXT_CONTRAST_MINIMUM],
      [SECONDARY_TEXT_PAIRS, SECONDARY_CONTRAST_MINIMUM],
    ] as const) {
      for (const pair of pairs) {
        const ratio = paletteContrast(palette[pair.foreground], palette[pair.background]);
        // An unreadable value was already reported above; scoring it again here would say the same
        // thing twice in different words.
        if (!ratio.ok || ratio.value >= required) continue;
        faults.push({
          kind: 'low-contrast',
          mode,
          foreground: pair.foreground,
          background: pair.background,
          ratio: ratio.value,
          required,
        });
      }
    }

    // Every pair, not just neighbours: a ramp ordered by hue has no meaningful neighbours, and the
    // closest pair in shadcn's colourful ramps is not an adjacent one.
    for (let index = 0; index < CHART_ROLES.length; index += 1) {
      for (let other = index + 1; other < CHART_ROLES.length; other += 1) {
        const roles = [CHART_ROLES[index]!, CHART_ROLES[other]!] as const;
        const distance = paletteDistance(palette[roles[0]], palette[roles[1]]);
        if (!distance.ok || distance.value >= CHART_DISTINCTNESS_MINIMUM) continue;
        faults.push({
          kind: 'indistinct-categories',
          mode,
          roles,
          distance: distance.value,
          required: CHART_DISTINCTNESS_MINIMUM,
        });
      }
    }
  }

  return faults;
}

/** A fault as one line, for a test failure that names the palette rather than a line number. */
export function describeFault(fault: ThemeFault): string {
  switch (fault.kind) {
    case 'unreadable-role':
      return `${fault.mode}: --${fault.role} is not a colour (${fault.value || 'missing'})`;
    case 'low-contrast':
      return `${fault.mode}: ${fault.foreground} on ${fault.background} is ${fault.ratio.toFixed(2)}:1, needs ${fault.required}:1`;
    case 'indistinct-categories':
      return `${fault.mode}: ${fault.roles[0]} and ${fault.roles[1]} differ by ΔE ${fault.distance.toFixed(4)}, needs ${fault.required}`;
  }
}
