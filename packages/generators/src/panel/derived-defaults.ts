import type { GeneratorParam } from '../contracts/manifest.js';

/**
 * Defaults the *application* supplies, named by what they derive from.
 *
 * A manifest can declare a literal default, and for most parameters that is right. It is wrong for
 * anything whose sensible value depends on the project: an output shaped 1:1 in a 16:9 sequence is
 * pillarboxed the moment it lands on the timeline, and a generator that quietly did that produced
 * results the user called badly generated without being able to say why.
 *
 * Declared rather than inferred. The manifest says `default_from: "project_aspect_ratio"` and this
 * resolves it; nothing keys off a parameter name, and nothing anywhere knows which generator is
 * asking. A new derivation is a case here and a string in a JSON file.
 *
 * The resolution is a *default*, never a constraint — the user overrides it like any other value,
 * which is the whole point of it being a default rather than a hidden binding.
 */

/** What a derived default may be derived from. */
export const DERIVED_DEFAULTS = ['project_aspect_ratio'] as const;

export type DerivedDefault = (typeof DERIVED_DEFAULTS)[number];

export function isDerivedDefault(value: string): value is DerivedDefault {
  return (DERIVED_DEFAULTS as readonly string[]).includes(value);
}

export interface ProjectShape {
  readonly width: number;
  readonly height: number;
}

/**
 * The value a derived default resolves to, given the project and the options actually on offer.
 *
 * `undefined` when nothing fits — an empty option list, a backend that renamed its labels — and the
 * caller falls back to the manifest's own default. Guessing at a value that is not in the list would
 * produce a select with no selection, which reads as a broken control.
 */
export function resolveDerivedDefault(
  kind: DerivedDefault,
  project: ProjectShape,
  options: readonly string[],
): string | undefined {
  switch (kind) {
    case 'project_aspect_ratio':
      return closestAspect(project, options);
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled derived default ${String(unreachable)}`);
    }
  }
}

/**
 * The offered option closest to the project's shape.
 *
 * Closest rather than exact, because the list a backend offers is a fixed set of named ratios and a
 * project may be any shape at all. Compared on the *logarithm* of the ratio so that being twice as
 * wide and half as wide are equally far away — a linear comparison prefers wider options for a tall
 * project, which is exactly the wrong bias.
 *
 * Orientation is part of the shape: a portrait project must not be handed `16:9` because its label
 * happens to be alphabetically first among near matches.
 */
function closestAspect(project: ProjectShape, options: readonly string[]): string | undefined {
  if (project.width <= 0 || project.height <= 0) return undefined;

  const target = Math.log(project.width / project.height);
  let best: { option: string; distance: number } | undefined;

  for (const option of options) {
    const ratio = parseAspect(option);
    if (ratio === undefined) continue;
    const distance = Math.abs(Math.log(ratio) - target);
    if (best === undefined || distance < best.distance) best = { option, distance };
  }

  return best?.option;
}

/**
 * The ratio in a label like `16:9 (Widescreen)`.
 *
 * Tolerant of the parenthetical, because that is how the backend writes them and a parser that
 * demanded a bare `16:9` would silently match nothing and leave every default unresolved.
 */
export function parseAspect(label: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)/u.exec(label);
  if (match === null) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return width / height;
}

/**
 * The effective default for one parameter: derived when it declares a derivation, declared otherwise.
 *
 * One function so the panel and anything else that needs a starting value cannot disagree about
 * which default wins — and the order is fixed here: a derivation that resolves beats the literal,
 * because it was chosen knowing the project and the literal was not.
 */
export function defaultFor(
  param: GeneratorParam,
  project: ProjectShape,
  options: readonly string[],
): string | number | boolean | undefined {
  const from = param.defaultFrom;
  if (from !== undefined && isDerivedDefault(from)) {
    const derived = resolveDerivedDefault(from, project, options);
    if (derived !== undefined) return derived;
  }
  return param.default;
}
