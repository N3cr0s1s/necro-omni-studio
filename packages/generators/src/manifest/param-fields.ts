import type { GeneratorParamType } from '../contracts/manifest.js';

/**
 * Which fields a parameter of a given type actually has.
 *
 * §5.9's claim is that a new generative capability is a JSON file authored from inside the
 * application, with no code. The inspector offered a parameter four fields — key, type, minimum,
 * maximum — out of the ten the format defines, so a manifest authored there came out with no labels,
 * no defaults, single-line prompt boxes, and **no way to upload an image at all**: `transport` is what
 * carries an asset to the backend, and nothing could set it. The manifest was authorable in the sense
 * that a file appeared.
 *
 * The fields are data rather than a chain of conditions in the panel, for the reason this codebase
 * keeps everything else that way: a new parameter type is then one entry here, and it arrives with
 * the right controls in every place that renders one. A condition per field in the panel is how the
 * four came to be the four — each one was added where it was needed and nobody ever saw the set.
 *
 * ## What decides whether a field belongs
 *
 * Whether it means anything for that type, and nothing else. A minimum on a boolean, a line-wrapping
 * flag on a number, an upload transport for an integer: each would be a control that does nothing,
 * and a panel that offers meaningless fields teaches the user to ignore all of them.
 */

/** A field of `GeneratorParam` a user can edit. `key`, `type` and `bind` are not here: every parameter has them. */
export type ParamField =
  | 'label'
  | 'min'
  | 'max'
  | 'step'
  | 'default'
  | 'defaultFrom'
  | 'options'
  | 'required'
  | 'multiline'
  | 'transport';

/** How a default is entered, which is a different question from whether there is one. */
export type DefaultControl = 'none' | 'number' | 'text' | 'boolean' | 'choice';

/** Types that name a file rather than a value. They are supplied at run time, never defaulted. */
export const ASSET_PARAM_TYPES: readonly GeneratorParamType[] = ['image', 'video', 'audio', 'mask'];

export const NUMERIC_PARAM_TYPES: readonly GeneratorParamType[] = ['int', 'float'];

/**
 * The fields that belong to a type, in the order a panel should show them.
 *
 * `label` and `required` are on every type: what a control is called and whether a run can proceed
 * without it are questions about the parameter, not about its value.
 */
export function fieldsFor(type: GeneratorParamType): readonly ParamField[] {
  const common: readonly ParamField[] = ['label', 'required'];

  if (NUMERIC_PARAM_TYPES.includes(type)) {
    return [...common, 'min', 'max', 'step', 'default', 'defaultFrom'];
  }
  if (ASSET_PARAM_TYPES.includes(type)) {
    // No default and no derived default: an asset is chosen when the run is set up, and a manifest
    // that named one would be naming a file that may not exist in this project.
    return [...common, 'transport'];
  }
  if (type === 'enum') return [...common, 'options', 'default', 'defaultFrom'];
  if (type === 'bool') return [...common, 'default'];
  if (type === 'seed') {
    // A seed's whole purpose is to vary. A default would be a value every run started from, which is
    // the opposite of what the field is for — `defaultVariants` decides how many seeds a run uses.
    return common;
  }

  // `text`, and anything added later that behaves like it.
  return [...common, 'multiline', 'default', 'defaultFrom'];
}

export function hasField(type: GeneratorParamType, field: ParamField): boolean {
  return fieldsFor(type).includes(field);
}

/** How the default is entered for a type, or `none` when the type has no default at all. */
export function defaultControl(type: GeneratorParamType): DefaultControl {
  if (!hasField(type, 'default')) return 'none';
  if (NUMERIC_PARAM_TYPES.includes(type)) return 'number';
  if (type === 'bool') return 'boolean';
  if (type === 'enum') return 'choice';
  return 'text';
}

/**
 * A typed default from what a text control produced.
 *
 * `undefined` clears the field, which is not the same as a default of `0` or `''` — the format omits
 * an absent default and the panel then falls back to whatever the graph itself holds. A number that
 * will not parse also clears rather than storing `NaN`, which would serialize as `null` and be
 * rejected by the schema on the way back in.
 */
export function parseDefault(type: GeneratorParamType, raw: string): string | number | boolean | undefined {
  if (raw === '') return undefined;

  switch (defaultControl(type)) {
    case 'none':
      return undefined;
    case 'number': {
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    case 'boolean':
      return raw === 'true';
    default:
      return raw;
  }
}

/** A stored default as text a control can show. */
export function defaultAsText(value: string | number | boolean | undefined): string {
  return value === undefined ? '' : String(value);
}
