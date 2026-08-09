/**
 * Settings that belong to the installation rather than to a project.
 *
 * §5.8 asks for a global override of the variant count — "a beállításokban van globális felülbírálás"
 * — and the job queue has taken a `globalVariantMaximum` since it was written. Nothing ever set it,
 * because there was nowhere for an application-level setting to live: `project.json` is the wrong
 * place by definition, since a cap on how much work a machine takes on follows the machine and not
 * the cut.
 *
 * So this is a file beside `session.json` in `userData`, for the same reason that one is there: it
 * belongs to the installation and has to survive every project being closed.
 *
 * ## Tolerant on the way in
 *
 * A settings file is edited by hand sooner or later, and one bad field must not cost the rest. Every
 * value is validated on its own and falls back to its default, so a file with one nonsense entry keeps
 * every other preference the user set. That is also what makes adding a setting safe: a file written
 * by an older build simply has defaults for what it does not mention.
 */

export interface AppSettings {
  /**
   * The most variants any single run may produce, whatever a manifest asks for.
   *
   * A ceiling rather than a count: the manifest still decides how many a generator *wants*, and a run
   * can still ask for fewer. This is the machine saying what it is willing to do, which is why it is
   * not in the project.
   */
  readonly variantMaximum: number;
}

/** What every setting is when nothing says otherwise. */
export const DEFAULT_SETTINGS: AppSettings = {
  // Eight, which is above every manifest default in the spec (audio 3, video 1) and far enough above
  // them to be a safety rail rather than a limit anyone meets by accident.
  variantMaximum: 8,
};

/** The narrowest and widest a cap can usefully be. One means "never batch"; the ceiling is a rail. */
export const VARIANT_MAXIMUM_RANGE = { min: 1, max: 16 } as const;

/**
 * Reads settings out of whatever was on disk.
 *
 * Never throws and never returns a partial: a caller gets a complete `AppSettings` or the defaults, so
 * nothing downstream has to ask whether a field is there.
 */
export function parseSettings(value: unknown): AppSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SETTINGS;
  const raw = value as Record<string, unknown>;

  return {
    variantMaximum: wholeNumberIn(
      raw['variantMaximum'],
      VARIANT_MAXIMUM_RANGE.min,
      VARIANT_MAXIMUM_RANGE.max,
      DEFAULT_SETTINGS.variantMaximum,
    ),
  };
}

/**
 * Applies a change, validating it the same way a file is validated.
 *
 * The renderer is not trusted to send a sane value — not because it is hostile, but because a control
 * with a typo in its `max` would otherwise write a cap nothing could later undo through the same
 * control.
 */
export function mergeSettings(current: AppSettings, patch: unknown): AppSettings {
  if (typeof patch !== 'object' || patch === null) return current;
  const raw = patch as Record<string, unknown>;

  return {
    variantMaximum:
      raw['variantMaximum'] === undefined
        ? current.variantMaximum
        : wholeNumberIn(
            raw['variantMaximum'],
            VARIANT_MAXIMUM_RANGE.min,
            VARIANT_MAXIMUM_RANGE.max,
            current.variantMaximum,
          ),
  };
}

/**
 * A whole number inside a range, or the fallback.
 *
 * Clamped rather than rejected when it is a number out of range: someone who typed 40 meant "as many
 * as you can", and giving them the ceiling is closer to that than giving them the default. Anything
 * that is not a finite number at all is a different case — it says nothing about intent, so the
 * fallback stands.
 */
function wholeNumberIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
