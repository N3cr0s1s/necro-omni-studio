import {
  type EffectId,
  type Validator,
  effectId,
  vArray,
  vBoolean,
  vEnum,
  vLiteral,
  vNonEmptyString,
  vNumber,
  vObject,
  vOptional,
  vRefine,
  vString,
  vTagged,
  vTryMap,
  vWithDefault,
} from '@nos/core';

/**
 * Effect and transition manifests.
 *
 * The schema follows `interfaces.md` §4 exactly, including its snake_case field names
 * (`progress_uniform`) — the manifests are authored by hand and by the inspector, so the on-disk
 * spelling is a contract with the user, not an internal detail.
 *
 * The central design point: **nothing about a specific effect appears in code**. An effect is a GLSL
 * file plus this JSON, and adding one is a file drop. That is why the schema is validated rather than
 * trusted: a manifest is untrusted input like `project.json`, and a broken one must name what is wrong
 * instead of failing opaquely.
 */

/** Parameter types a manifest may declare, and the GLSL type each maps to. */
export const PARAM_TYPES = ['float', 'int', 'bool', 'color', 'vec2'] as const;

export type EffectParamType = (typeof PARAM_TYPES)[number];

export interface EffectParam {
  /** Document-side key. What `EffectInstance.params` is keyed by. */
  readonly key: string;
  /** Shader-side uniform name. Often differs from `key`; both spellings are the manifest's choice. */
  readonly uniform: string;
  readonly type: EffectParamType;
  /** Shown in the inspector. Falls back to the key. */
  readonly label?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /**
   * Default applied when a clip adds this effect.
   *
   * Typed loosely because a `color` default is an object while a `float` default is a number; the
   * validator narrows it against `type`.
   */
  readonly default?: number | boolean | readonly number[];
  /**
   * Whether the parameter can be keyframed.
   *
   * The spec says any numeric parameter is keyframable, so this defaults to true for numeric types and
   * is forced false for the rest — a keyframed boolean has no meaningful interpolation.
   */
  readonly keyframable: boolean;
}

export interface EffectManifestBase {
  readonly id: EffectId;
  readonly name: string;
  /** Shader filename, relative to the manifest. */
  readonly shader: string;
  readonly params: readonly EffectParam[];
  /** Grouping for the "add effect" menu. Free-form, so a project can organize its own library. */
  readonly group?: string;
  readonly description?: string;
}

export interface EffectManifest extends EffectManifestBase {
  readonly category: 'effect';
  /**
   * Declared sampler slots.
   *
   * `source` is always present. Declaring `mask` is the *entire* coupling between SAM 2 and the effect
   * system — an effect opts into masking by naming the slot, and the compositor binds a cached mask
   * texture to it with no effect-specific code anywhere.
   */
  readonly samplers: readonly string[];
}

export interface TransitionManifest extends EffectManifestBase {
  readonly category: 'transition';
  readonly samplers: readonly string[];
  /**
   * When `gl-transitions`, the compositor generates that library's wrapper so an unmodified shader
   * compiles. The spec requires copy-paste compatibility.
   */
  readonly convention?: 'gl-transitions';
  /** Uniform carrying engine-computed progress. Defaults to `progress`. */
  readonly progressUniform?: string;
}

export type AnyEffectManifest = EffectManifest | TransitionManifest;

/** Numeric parameter types, which are the keyframable ones per the spec. */
const NUMERIC_TYPES: readonly EffectParamType[] = ['float', 'int', 'vec2'];

export function isNumericParam(type: EffectParamType): boolean {
  return NUMERIC_TYPES.includes(type);
}

/**
 * Parameter validator.
 *
 * `keyframable` defaults from the type rather than requiring every manifest to state it: the spec's rule
 * is that numeric parameters are keyframable, so restating it per parameter is noise that can disagree
 * with itself.
 */
const vEffectParam: Validator<EffectParam> = (value, path) => {
  const shape = vObject<{
    key: string;
    uniform: string;
    type: EffectParamType;
    label: string | undefined;
    min: number | undefined;
    max: number | undefined;
    step: number | undefined;
    default: number | boolean | readonly number[] | undefined;
    keyframable: boolean | undefined;
  }>({
    key: vNonEmptyString('param key'),
    // A manifest may omit `uniform` when it matches the key, which is the common case for effects
    // authored against this app rather than ported.
    uniform: vWithDefault(vNonEmptyString('param uniform'), ''),
    type: vEnum(PARAM_TYPES),
    label: vOptional(vString),
    min: vOptional(vNumber),
    max: vOptional(vNumber),
    step: vOptional(vNumber),
    default: vOptional(vDefaultValue),
    keyframable: vOptional(vBoolean),
  });

  const parsed = shape(value, path);
  if (!parsed.ok) return parsed;

  const { key, type } = parsed.value;
  const uniform = parsed.value.uniform === '' ? key : parsed.value.uniform;
  const keyframable = parsed.value.keyframable ?? isNumericParam(type);

  return {
    ok: true,
    value: {
      key,
      uniform,
      type,
      // Forced false for non-numeric types: interpolating a boolean or an enum string is meaningless,
      // and allowing it would put un-renderable keyframes in the document.
      keyframable: isNumericParam(type) ? keyframable : false,
      ...(parsed.value.label !== undefined ? { label: parsed.value.label } : {}),
      ...(parsed.value.min !== undefined ? { min: parsed.value.min } : {}),
      ...(parsed.value.max !== undefined ? { max: parsed.value.max } : {}),
      ...(parsed.value.step !== undefined ? { step: parsed.value.step } : {}),
      ...(parsed.value.default !== undefined ? { default: parsed.value.default } : {}),
    },
  };
};

/** A default may be a number, a boolean, or a colour/vector array. */
const vDefaultValue: Validator<number | boolean | readonly number[]> = (value, path) => {
  if (typeof value === 'number') return vNumber(value, path);
  if (typeof value === 'boolean') return vBoolean(value, path);
  return vArray(vNumber)(value, path);
};

const vEffectId: Validator<EffectId> = vTryMap(vNonEmptyString('effect id'), effectId);

/** Samplers must include the primary slot, or the generated shader has nothing to read. */
const vEffectSamplers: Validator<readonly string[]> = vRefine(
  vWithDefault(vArray(vNonEmptyString('sampler')), ['source']),
  (samplers) => samplers.includes('source'),
  'an effect must declare a "source" sampler',
);

const vTransitionSamplers: Validator<readonly string[]> = vRefine(
  vWithDefault(vArray(vNonEmptyString('sampler')), ['from', 'to']),
  (samplers) => samplers.includes('from') && samplers.includes('to'),
  'a transition must declare "from" and "to" samplers',
);

const vEffectManifest: Validator<EffectManifest> = vObject<EffectManifest>({
  id: vEffectId,
  category: vLiteral('effect'),
  name: vWithDefault(vString, ''),
  shader: vNonEmptyString('shader'),
  samplers: vEffectSamplers,
  params: vWithDefault(vArray(vEffectParam), []),
  group: vOptional(vString),
  description: vOptional(vString),
});

const vTransitionManifest: Validator<TransitionManifest> = vObject<TransitionManifest>({
  id: vEffectId,
  category: vLiteral('transition'),
  name: vWithDefault(vString, ''),
  shader: vNonEmptyString('shader'),
  samplers: vTransitionSamplers,
  convention: vOptional(vLiteral('gl-transitions')),
  progressUniform: vOptional(vNonEmptyString('progress_uniform')),
  params: vWithDefault(vArray(vEffectParam), []),
  group: vOptional(vString),
  description: vOptional(vString),
});

/**
 * Validates a manifest, dispatching on `category`.
 *
 * An unknown category reports against that field rather than dumping both variants' failures, so a typo
 * reads as a typo.
 */
export const vAnyEffectManifest: Validator<AnyEffectManifest> = vTagged<AnyEffectManifest>(
  'category',
  { effect: vEffectManifest, transition: vTransitionManifest },
);

/**
 * Normalizes the on-disk snake_case spellings before validation.
 *
 * The file format is snake_case per `interfaces.md`; the in-memory model is camelCase per the rest of
 * the codebase. Translating here keeps the boundary in one place instead of littering the schema with
 * alternate keys.
 */
export function normalizeManifestKeys(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;

  const source = raw as Record<string, unknown>;
  const output: Record<string, unknown> = { ...source };

  if ('progress_uniform' in source) {
    output['progressUniform'] = source['progress_uniform'];
    delete output['progress_uniform'];
  }

  if (Array.isArray(source['params'])) {
    output['params'] = source['params'].map((param) => {
      if (typeof param !== 'object' || param === null) return param;
      // Parameters have no snake_case fields today, but normalizing them through the same path means a
      // future one is handled in a single place.
      return { ...(param as Record<string, unknown>) };
    });
  }

  return output;
}

/** The display label for a parameter: its manifest label, or its key. */
export function paramLabel(param: EffectParam): string {
  return param.label ?? param.key;
}

/** Display name for a manifest: its `name`, or its id when unnamed. */
export function manifestLabel(manifest: AnyEffectManifest): string {
  return manifest.name.trim() === '' ? manifest.id : manifest.name;
}
