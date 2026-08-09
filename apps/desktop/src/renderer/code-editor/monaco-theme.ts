import type { editor } from 'monaco-editor/editor/editor.api.js';
import { type Srgb, contrastRatio, oklchToSrgb, relativeLuminance } from '@nos/ui';

/**
 * A Monaco theme built from the palette that is actually on screen — issue #35.
 *
 * Monaco needs literal colours; this application only ever names roles, and six themes can be
 * chosen between at runtime. Hard-coding a syntax palette would be the one place in the editor that
 * ignores the theme, and it would be unreadable in at least one of them.
 *
 * ## Why the colours are measured rather than read
 *
 * The roles are declared as `oklch(...)` custom properties, and what `getComputedStyle` hands back
 * for one varies by engine and version — `oklch(...)`, `oklab(...)`, `color(srgb ...)`, sometimes
 * `rgb(...)`. Parsing all of those is a job with no end. Painting the colour into a 1×1 canvas and
 * reading the pixel gives sRGB whatever the syntax was, and the browser has already done the
 * conversion correctly.
 *
 * ## Why syntax colours are corrected for contrast
 *
 * The categorical roles this palette offers reach 1.42:1 against the surfaces they sit on in the
 * worst shipped pairing, and code is the smallest text in the window. Rather than give up colour —
 * which is most of what was asked for — each syntax colour is walked toward the foreground until it
 * clears AA against the editor's own background. The result is a real syntax palette that is legible
 * by construction in every theme, instead of one that is legible in the theme it was chosen in.
 */

/** Minimum contrast a syntax colour must reach against the editor background. WCAG AA for body text. */
export const SYNTAX_CONTRAST_MINIMUM = 4.5;

/**
 * The sRGB a CSS colour expression resolves to, measured.
 *
 * Returns `undefined` when there is no canvas — jsdom, and the harness that renders components
 * without a document. Every caller falls back to Monaco's own defaults rather than to a guess.
 */
export function measureCssColor(expression: string): Srgb | undefined {
  if (typeof document === 'undefined') return undefined;

  const probe = document.createElement('span');
  probe.style.color = expression;
  probe.style.display = 'none';
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return undefined;

  context.fillStyle = resolved;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined) return undefined;

  return { r: r / 255, g: g / 255, b: b / 255 };
}

/** The colour a role resolves to right now. */
export function measureRole(role: string): Srgb | undefined {
  return measureCssColor(`var(--${role})`);
}

export function toHex(color: Srgb): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/**
 * A colour moved toward legibility against a background, keeping as much of its hue as it can.
 *
 * Lightness is what contrast is made of, so lightness is what moves: the colour is stepped toward
 * white on a dark background and toward black on a light one until it clears the minimum. Chroma is
 * left alone, so a "keyword blue" stays recognisably blue rather than turning grey — which is what
 * blending toward the foreground would do.
 */
export function readableOn(color: Srgb, background: Srgb, minimum = SYNTAX_CONTRAST_MINIMUM): Srgb {
  if (contrastRatio(color, background) >= minimum) return color;

  const towardWhite = relativeLuminance(background) < 0.5;
  let current = color;

  // Sixteen steps of 6%: enough to cross the full range, and bounded so a colour that can never reach
  // the minimum — a mid grey on a mid grey — stops rather than looping.
  for (let step = 0; step < 16; step += 1) {
    current = towardWhite
      ? { r: lift(current.r), g: lift(current.g), b: lift(current.b) }
      : { r: current.r * 0.94, g: current.g * 0.94, b: current.b * 0.94 };
    if (contrastRatio(current, background) >= minimum) return current;
  }

  return current;
}

function lift(value: number): number {
  return value + (1 - value) * 0.12;
}

/** The roles a syntax palette is derived from, and what each colours. */
export interface SyntaxRoles {
  readonly comment: string;
  readonly keyword: string;
  readonly type: string;
  readonly number: string;
  readonly string: string;
  readonly predefined: string;
}

/**
 * Which role paints which token.
 *
 * The categorical roles, because that is what they are for — five distinguishable hues chosen by the
 * theme's author. Comments take the muted foreground: they are the one category that should recede,
 * and giving them a hue makes a file of documented code look like a warning.
 */
export const DEFAULT_SYNTAX_ROLES: SyntaxRoles = {
  comment: 'muted-foreground',
  keyword: 'chart-1',
  type: 'chart-2',
  number: 'chart-3',
  string: 'chart-4',
  predefined: 'chart-5',
};

export const MONACO_THEME_ID = 'nos';

/**
 * The theme, measured from the palette in force.
 *
 * Rebuilt whenever the theme changes — the caller watches the attribute and calls again, because
 * Monaco holds themes by name and redefining one restyles every open editor at once.
 */
export function buildMonacoTheme(roles: SyntaxRoles = DEFAULT_SYNTAX_ROLES): editor.IStandaloneThemeData {
  const background = measureRole('card') ?? measureRole('background');
  const foreground = measureRole('foreground');

  // No canvas, or a palette that has not been applied yet. Monaco's own dark theme is a better
  // answer than a half-measured one, and this is the state the component tests run in.
  if (background === undefined || foreground === undefined) {
    return { base: 'vs-dark', inherit: true, rules: [], colors: {} };
  }

  const dark = relativeLuminance(background) < 0.5;
  const colourFor = (role: string): string => {
    const measured = measureRole(role);
    return toHex(readableOn(measured ?? foreground, background));
  };

  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: toHex(foreground).slice(1) },
      { token: 'comment', foreground: colourFor(roles.comment).slice(1), fontStyle: 'italic' },
      { token: 'keyword', foreground: colourFor(roles.keyword).slice(1) },
      { token: 'keyword.directive', foreground: colourFor(roles.keyword).slice(1) },
      { token: 'type', foreground: colourFor(roles.type).slice(1) },
      { token: 'number', foreground: colourFor(roles.number).slice(1) },
      { token: 'number.float', foreground: colourFor(roles.number).slice(1) },
      { token: 'number.hex', foreground: colourFor(roles.number).slice(1) },
      { token: 'string', foreground: colourFor(roles.string).slice(1) },
      // JSON property names read as strings to the tokenizer; they are what a manifest is scanned
      // for, so they get their own weight rather than their own hue.
      { token: 'string.key.json', foreground: toHex(foreground).slice(1), fontStyle: 'bold' },
      { token: 'string.value.json', foreground: colourFor(roles.string).slice(1) },
      { token: 'predefined', foreground: colourFor(roles.predefined).slice(1) },
      { token: 'variable.predefined', foreground: colourFor(roles.predefined).slice(1) },
      { token: 'delimiter', foreground: colourFor(roles.comment).slice(1) },
      { token: 'operator', foreground: colourFor(roles.comment).slice(1) },
    ],
    colors: {
      'editor.background': toHex(background),
      'editor.foreground': toHex(foreground),
      'editorLineNumber.foreground': toHex(measureRole('muted-foreground') ?? foreground),
      'editorGutter.background': toHex(background),
      'editorWidget.background': toHex(measureRole('popover') ?? background),
      'editorWidget.border': toHex(measureRole('border') ?? background),
      'editorSuggestWidget.background': toHex(measureRole('popover') ?? background),
      'editorSuggestWidget.selectedBackground': toHex(measureRole('accent') ?? background),
      'editorHoverWidget.background': toHex(measureRole('popover') ?? background),
      'editor.selectionBackground': toHex(measureRole('accent') ?? background),
      'editorCursor.foreground': toHex(foreground),
      'editorIndentGuide.background1': toHex(measureRole('border') ?? background),
    },
  };
}

/** Re-exported so a caller need not reach into the theme package for the one conversion it needs. */
export { oklchToSrgb };
