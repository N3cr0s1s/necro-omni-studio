import type { PresetId } from '@nos/core';
import { presetId } from '@nos/core';
import type { GeneratorPreset } from '../contracts/manifest.js';
import type { DraftParam, ManifestDraft } from './manifest-draft.js';
import { parseDefault } from './param-fields.js';

/**
 * Authoring a generator's presets.
 *
 * §5.7's presets are what make one graph feel like several tools — "Music", "SFX", "One-shot" over a
 * single audio generator — and two of the shipped manifests carry six between them. The inspector
 * could not author one: `presets` was not mentioned anywhere in the panel, so a generator written
 * inside the application had none and no way to get any.
 *
 * ## The distinction this has to make visible
 *
 * A preset says two different things about a parameter and the difference is the whole feature.
 * **Pinned** is what constitutes the preset — hidden, fixed, the reason it is its own tool. **Set** is
 * a starting point, pre-filled and still editable. The contract records what happens when the two are
 * confused: every value became a lock, and a one-shot preset that pinned its length left no way to ask
 * for a slightly longer one, because the control was gone rather than pre-filled.
 *
 * So a parameter is in one of three states in a given preset, and the editor asks for exactly that:
 * free, pinned, or pre-filled. Modelling it as two independent records — which is how the file stores
 * it — would let a key be in both at once, which the format has no meaning for.
 */

/** What a preset says about one parameter. */
export type PresetRole = 'free' | 'pinned' | 'prefilled';

export const PRESET_ROLES: readonly PresetRole[] = ['free', 'pinned', 'prefilled'];

/** How a preset treats a parameter. `free` means it says nothing about it. */
export function roleOf(preset: GeneratorPreset, key: string): PresetRole {
  if (key in preset.pin) return 'pinned';
  if (preset.set !== undefined && key in preset.set) return 'prefilled';
  return 'free';
}

/** The value a preset gives a parameter, whichever way it gives it. */
export function valueIn(preset: GeneratorPreset, key: string): string | number | boolean | undefined {
  return preset.pin[key] ?? preset.set?.[key];
}

/**
 * Moves a parameter between the three states, carrying its value across.
 *
 * The value survives a change of role, because changing your mind about whether a value is fixed or
 * merely suggested should not make you type it again. Going to `free` drops it, which is the only
 * honest reading of "this preset says nothing about this parameter".
 *
 * A parameter can never be in both records: it is removed from each before being written to one.
 */
export function setRole(
  preset: GeneratorPreset,
  key: string,
  role: PresetRole,
  fallback?: string | number | boolean,
): GeneratorPreset {
  const carried = valueIn(preset, key) ?? fallback;
  const pin = without(preset.pin, key);
  const set = without(preset.set ?? {}, key);

  if (role === 'pinned') {
    // A pinned parameter with no value at all is meaningless — it is the value that constitutes the
    // preset — so an empty carry becomes an empty string rather than an absent key.
    return normalize({ ...preset, pin: { ...pin, [key]: carried ?? '' }, set });
  }
  if (role === 'prefilled') {
    return normalize({ ...preset, pin, set: { ...set, [key]: carried ?? '' } });
  }
  return normalize({ ...preset, pin, set });
}

/** Changes the value a preset gives a parameter, leaving which record it is in alone. */
export function setValue(
  preset: GeneratorPreset,
  key: string,
  value: string | number | boolean,
): GeneratorPreset {
  const role = roleOf(preset, key);
  if (role === 'free') return preset;
  if (role === 'pinned') return normalize({ ...preset, pin: { ...preset.pin, [key]: value } });
  return normalize({ ...preset, set: { ...(preset.set ?? {}), [key]: value } });
}

/**
 * A typed value from what a control produced, using the parameter's own type.
 *
 * The same conversion a default goes through, deliberately: a preset value is patched into the graph
 * exactly like one, so a number stored as text fails in the same place and for the same reason.
 */
export function parsePresetValue(param: DraftParam, raw: string): string | number | boolean | undefined {
  return parseDefault(param.type, raw);
}

/** Drops an empty `set`, which the format omits and a reader would otherwise have to skip. */
function normalize(preset: GeneratorPreset): GeneratorPreset {
  if (preset.set !== undefined && Object.keys(preset.set).length === 0) {
    const { set: _unused, ...rest } = preset;
    return rest;
  }
  return preset;
}

function without(
  record: Readonly<Record<string, string | number | boolean>>,
  key: string,
): Readonly<Record<string, string | number | boolean>> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/**
 * A new preset, named so it is distinguishable before it is renamed.
 *
 * Numbered from what is already there rather than from the count, so removing the second of three and
 * adding one does not produce a duplicate id — ids address a preset in `project.json`'s provenance and
 * two presets sharing one is a recall that loads the wrong settings.
 */
export function addPreset(draft: ManifestDraft): ManifestDraft {
  const taken = new Set(draft.presets.map((preset) => preset.id as string));
  let index = draft.presets.length + 1;
  while (taken.has(`preset_${index}`)) index += 1;

  return {
    ...draft,
    presets: [...draft.presets, { id: presetId(`preset_${index}`), name: `Preset ${index}`, pin: {} }],
  };
}

export function removePreset(draft: ManifestDraft, id: PresetId): ManifestDraft {
  return { ...draft, presets: draft.presets.filter((preset) => preset.id !== id) };
}

/** Replaces one preset, addressed by the id it had. */
export function editPreset(draft: ManifestDraft, id: PresetId, next: GeneratorPreset): ManifestDraft {
  return {
    ...draft,
    presets: draft.presets.map((preset) => (preset.id === id ? next : preset)),
  };
}

/**
 * What is wrong with a draft's presets.
 *
 * Reported rather than prevented: a preset naming a parameter that has since been renamed is an
 * ordinary consequence of editing, and silently dropping the entry would lose a value the author
 * meant to keep. Naming it lets them fix the name instead.
 */
export interface PresetIssue {
  readonly presetId: string;
  /** Index in the draft, so `validateDraft` can address it the way it addresses everything else. */
  readonly index: number;
  readonly message: string;
  /**
   * An error blocks Save; a warning does not.
   *
   * A duplicate id and an empty name both break something a user will meet — two presets that cannot
   * be told apart, a button with no label — so they block. A preset naming a parameter that has since
   * been renamed does not: the file is still valid, the value is still there to be re-pointed, and
   * refusing to save would trap someone mid-rename with no way out.
   */
  readonly severity: 'error' | 'warning';
}

export function presetIssues(draft: ManifestDraft): readonly PresetIssue[] {
  const keys = new Set(draft.params.map((param) => param.key));
  const seen = new Set<string>();
  const issues: PresetIssue[] = [];

  draft.presets.forEach((preset, index) => {
    const id = preset.id as string;
    if (seen.has(id)) {
      issues.push({ presetId: id, index, severity: 'error', message: `duplicate preset id "${id}"` });
    }
    seen.add(id);

    if (id.trim() === '') {
      issues.push({ presetId: id, index, severity: 'error', message: 'a preset needs an id' });
    }
    if (preset.name.trim() === '') {
      issues.push({ presetId: id, index, severity: 'error', message: 'a preset needs a name' });
    }

    for (const key of [...Object.keys(preset.pin), ...Object.keys(preset.set ?? {})]) {
      if (!keys.has(key)) {
        issues.push({
          presetId: id,
          index,
          severity: 'warning',
          message: `names a parameter that does not exist: "${key}"`,
        });
      }
    }
  });

  return issues;
}
