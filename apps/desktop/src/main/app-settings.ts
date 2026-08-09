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
   * Where ComfyUI is, per §3's "a backend endpointok konfigurálhatók".
   *
   * It was read from the environment and nowhere else, which makes it configurable only by whoever
   * launches the process — not by the person using it. An empty string means "wherever the default
   * is", so clearing the field returns to it rather than pointing at nothing.
   */
  readonly backendUrl: string;
  /**
   * The most variants any single run may produce, whatever a manifest asks for.
   *
   * A ceiling rather than a count: the manifest still decides how many a generator *wants*, and a run
   * can still ask for fewer. This is the machine saying what it is willing to do, which is why it is
   * not in the project.
   */
  readonly variantMaximum: number;
  /**
   * Which palette the editor draws in, per issue #21's "lehet majd több theme is".
   *
   * An installation setting rather than a project one, and for the same reason as the others here: a
   * palette is a property of the person and the screen, not of the cut. Two people opening the same
   * project should not be arguing about its colours through `project.json`.
   *
   * Empty means "whichever theme the application ships in", exactly as `backendUrl` does. The list of
   * themes lives in `@nos/ui`, and the main process may import types from the workspace but never
   * values — so it cannot ask whether an id is one this build has, and it does not try. What it
   * guarantees is the *shape*: something safe to interpolate into a `data-theme` attribute. Deciding
   * whether the id names a real theme is the renderer's job, and `themeById` already falls back for
   * an id it does not recognise, which is what a settings file written by a later build looks like.
   *
   * It sits beside the appearance — light, dark or system — which `next-themes` keeps for itself; the
   * two axes are independent and every theme answers for both.
   */
  readonly theme: string;
}

/** What every setting is when nothing says otherwise. */
export const DEFAULT_SETTINGS: AppSettings = {
  // Eight, which is above every manifest default in the spec (audio 3, video 1) and far enough above
  // them to be a safety rail rather than a limit anyone meets by accident.
  variantMaximum: 8,
  // Empty rather than the address itself: the default belongs to whoever resolves it, and storing a
  // copy here would freeze today's default into every settings file ever written.
  backendUrl: '',
  // Empty for the same reason: the application's default theme is named once, in `@nos/ui`, and a
  // copy here would be a second answer to a question that has one.
  theme: '',
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
    backendUrl: httpUrl(raw['backendUrl'], DEFAULT_SETTINGS.backendUrl),
    theme: themeId(raw['theme'], DEFAULT_SETTINGS.theme),
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
    backendUrl:
      raw['backendUrl'] === undefined ? current.backendUrl : httpUrl(raw['backendUrl'], current.backendUrl),
    theme: raw['theme'] === undefined ? current.theme : themeId(raw['theme'], current.theme),
  };
}

/**
 * An id safe to write into a `data-theme` attribute, or the fallback.
 *
 * Shape only — lowercase letters, digits and dashes — because that is the whole of what this side of
 * the boundary can know. The guard is not about a mistyped theme name, which is harmless and falls
 * back in the renderer; it is about the fact that this string ends up inside a CSS attribute selector
 * and an HTML attribute, and a settings file is exactly the kind of thing that gets pasted into.
 *
 * Empty is allowed and meaningful: it is how the field says "the application's default".
 */
function themeId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return /^[a-z0-9-]{1,32}$/.test(trimmed) ? trimmed : fallback;
}

/**
 * An `http` or `https` address, trailing slashes removed, or the fallback.
 *
 * The scheme is checked rather than assumed: a stored `file:` or `javascript:` would be handed to
 * `fetch` by the renderer, and a settings file is exactly the kind of thing that gets pasted into.
 * Empty is allowed and meaningful — it is how the field says "use the default".
 */
function httpUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : fallback;
  } catch {
    return fallback;
  }
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
