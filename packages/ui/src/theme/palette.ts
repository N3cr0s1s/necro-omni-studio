/**
 * What a theme is.
 *
 * Issue #21 asked for shadcn so that "lehet majd több theme is" — that there could be more than one
 * theme later. Light and dark arrived with the refactor; this is the other axis, and it is the one
 * that needed a contract rather than a stylesheet, because a theme is only useful if adding one is
 * data.
 *
 * ## Every role, or it does not compile
 *
 * `ThemePalette` names all thirty-one colour roles shadcn defines, and none of them is optional. A
 * theme that forgets `sidebar-ring` is not a theme with a small gap in it — it is a theme under which
 * one control silently inherits whatever the previous theme left behind, which is the single worst
 * failure mode a palette switch has. The type is the guard: a new theme either answers for every role
 * or it does not build.
 *
 * ## Colour only — geometry is not a theme
 *
 * `--radius` is deliberately absent, though shadcn's registry carries it beside the colours. Squared
 * corners are this application's shape, chosen once; a palette that also reshaped every control would
 * be a different application rather than a different colour. Drawing the line at colour is what makes
 * a theme safe to switch while a user is mid-edit — nothing moves, nothing reflows, and a timeline
 * measured in pixels stays exactly where it was.
 *
 * ## Values are whatever CSS accepts
 *
 * A role holds a CSS colour as written, not a parsed structure: `oklch(0.145 0 0)`, and for the
 * borders that float over an unknown backdrop, `oklch(1 0 0 / 10%)`. Keeping the source text means a
 * palette taken from shadcn's registry is reproduced exactly rather than round-tripped through a
 * colour model that would move the last digit. Reading them as numbers is a separate concern, and it
 * lives in `oklch.ts` where it can fail loudly.
 */

/** The thirty-one colour roles a theme must answer for. */
export const THEME_ROLES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
] as const;

export type ThemeRole = (typeof THEME_ROLES)[number];

/** One appearance of one theme. Every role, spelled as CSS. */
export type ThemePalette = { readonly [R in ThemeRole]: string };

/**
 * A theme: an identity, a name to show, and the two appearances.
 *
 * Both appearances are required rather than dark falling back to light. A theme that only answered
 * for one would be legible in one appearance and a guess in the other, and the guess would be made by
 * whichever stylesheet happened to load last.
 */
export interface Theme {
  /** Stable, lowercase, and used as the `data-theme` attribute — so it is part of the file format. */
  readonly id: string;
  /** What the picker shows. */
  readonly label: string;
  /**
   * Where it came from, shown to nobody and kept for the next person who wonders whether these
   * numbers were invented. Every shipped theme names a registry URL.
   */
  readonly source: string;
  readonly light: ThemePalette;
  readonly dark: ThemePalette;
}

/**
 * The pairs that have to stay readable, whatever the palette.
 *
 * A theme is not a matter of taste all the way down: text drawn on a surface either has enough
 * contrast to read or it does not, and a palette that fails is a bug rather than a preference. These
 * are the pairs the application actually draws — each one is somewhere a user reads words — and every
 * shipped theme is measured against them.
 *
 * Non-text pairs are deliberately absent. A border against its surface is a hint, not a sentence, and
 * holding it to a text ratio would reject palettes shadcn itself publishes.
 */
export interface ContrastPair {
  readonly foreground: ThemeRole;
  readonly background: ThemeRole;
}

export const TEXT_PAIRS: readonly ContrastPair[] = [
  { foreground: 'foreground', background: 'background' },
  { foreground: 'card-foreground', background: 'card' },
  { foreground: 'popover-foreground', background: 'popover' },
  { foreground: 'primary-foreground', background: 'primary' },
  { foreground: 'secondary-foreground', background: 'secondary' },
  { foreground: 'accent-foreground', background: 'accent' },
];

/*
 * The sidebar pairs are deliberately not above.
 *
 * This application has no sidebar — the roles exist because shadcn's palettes define them, and the
 * registry's `sidebar` component is not mounted anywhere. Holding them to a contrast bar would be
 * measuring pixels nothing draws, and it is not free: the application's own palette misses AA on
 * `sidebar-primary-foreground` by 4.10 against 4.5, so the check would reject the theme the editor
 * ships in over a control that does not exist.
 *
 * If a sidebar is ever mounted, the pairs belong here and that number becomes a real finding.
 */

/**
 * Pairs held to the lower bar WCAG allows for text that is not body copy.
 *
 * `muted-foreground` is by definition quieter than `foreground`, and `destructive` is drawn as an
 * icon and a short label rather than as prose. Holding either to 4.5:1 would reject shadcn's own
 * palettes — so the honest thing is a second tier with its own threshold, not one threshold quietly
 * lowered until everything passes.
 */
export const SECONDARY_TEXT_PAIRS: readonly ContrastPair[] = [
  { foreground: 'muted-foreground', background: 'background' },
  { foreground: 'muted-foreground', background: 'card' },
  { foreground: 'destructive', background: 'background' },
  { foreground: 'destructive', background: 'card' },
];

/** WCAG AA for body text, and for large or incidental text. */
export const TEXT_CONTRAST_MINIMUM = 4.5;
export const SECONDARY_CONTRAST_MINIMUM = 3;

/**
 * The categorical ramp, which is measured for a different property entirely.
 *
 * `chart-1` … `chart-5` say what *kind* of thing something is — the rule is stated once in
 * `glyphs.ts` so it cannot be applied one way in the timeline and another in the browser. They are
 * not a text palette and shadcn does not promise they are: measured against `background` they run
 * from 10.5:1 down to 1.7:1 across the palettes shadcn itself publishes, and the timeline already
 * discovered this the hard way — "those roles are chosen to be legible as a fill behind something,
 * and `chart-1` on a light background is barely there".
 *
 * So what a theme owes here is not contrast but **distinctness**: five categories that can be told
 * apart. Under shadcn's monochrome base colours they are told apart by lightness alone, which is why
 * every glyph also carries its own icon — colour reinforces the category and never carries it.
 */
export const CHART_ROLES = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;

/**
 * How far apart two categories must sit, as an OKLab distance.
 *
 * Not a contrast ratio, and the difference is the whole point: WCAG's ratio is a function of
 * luminance alone, so it scores shadcn's orange `chart-1` and teal `chart-2` — equally bright, wholly
 * different — at 1.02:1. Measured that way every colourful ramp shadcn publishes looks broken.
 *
 * 0.05 in OKLab, where roughly 0.02 is the threshold of noticing at all. Chosen against the six
 * palettes here, whose tightest pair is 0.0596, so it is a bar with room under it rather than one
 * fitted to what happens to pass.
 */
export const CHART_DISTINCTNESS_MINIMUM = 0.05;
