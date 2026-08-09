import type { AssetType, GeneratorId, PresetId } from '@nos/core';
import { generatorId } from '@nos/core';
import type { GraphLiteral } from '../contracts/introspection.js';
import type {
  AlsoBinding,
  ExclusiveGroupDescriptor,
  DurationMode,
  GeneratorManifest,
  GeneratorParam,
  GeneratorParamType,
  OutputDescriptor,
  SurfaceId,
} from '../contracts/manifest.js';
import type { DurationSource } from '../staging/placeholder.js';

/**
 * The manifest draft.
 *
 * The spec's §5.9 in model form: the inspector lists a graph's literal inputs, the user ticks which become
 * parameters and gives each a type and a range, and the manifest is written out. **No code is written.**
 *
 * Pure and serializable on purpose. The inspector UI is then a rendering of this value, the draft can be
 * saved half-finished, and every rule about what makes a manifest valid is asserted here once rather than
 * in a form component where it would be untestable.
 */

/** A literal the user has promoted to a parameter, with the choices they made about it. */
export interface DraftParam {
  /**
   * Stable identity, opaque and never shown.
   *
   * Separate from the pointer because a parameter may legitimately have **no** pointer — the spec writes
   * manifests before their graphs exist — and two unbound parameters would then be indistinguishable.
   */
  readonly id: string;
  /** Where it binds in the graph. Empty until the graph is connected. */
  readonly pointer: string;
  readonly key: string;
  readonly label?: string;
  readonly type: GeneratorParamType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly default?: string | number | boolean;
  readonly options?: readonly string[];
  readonly required?: boolean;
  readonly multiline?: boolean;
  readonly transport?: string;
  /**
   * Secondary patch targets, the spec's `also` mechanism.
   *
   * Carried through the draft rather than only through the manifest because the inspector *round
   * trips*: opening an authored manifest and saving it back used to drop these, and the project's own
   * MiniMax manifests bind `fps` both as a literal and inside a length expression. Losing the second
   * one leaves the expression stale and delivers a clip of the wrong duration, with nothing said.
   */
  readonly also?: readonly AlsoBinding[];
  /** What a default is derived from when the manifest cannot know it, e.g. the project's shape. */
  readonly defaultFrom?: string;
}

export interface ManifestDraft {
  readonly id: string;
  readonly name: string;
  readonly backend: string;
  readonly graph: string | null;
  readonly produces: AssetType;
  readonly consumes: GeneratorManifest['consumes'];
  readonly surfaces: readonly SurfaceId[];
  readonly duration: DurationMode;
  /**
   * Which parameter carries a `declared` length, and in what unit.
   *
   * Explicit rather than inferred: without it `durationSource` falls back to a key convention, so a
   * manifest whose length parameter is called anything else sizes every placeholder from the fallback
   * — the user asks for ten seconds and gets the default, with nothing on screen to explain it.
   */
  readonly durationFrom?: DurationSource;
  readonly defaultVariants: number;
  readonly batch?: { readonly bind: string; readonly max: number };
  readonly requires: readonly string[];
  readonly outputs: readonly OutputDescriptor[];
  readonly params: readonly DraftParam[];
  readonly presets: GeneratorManifest['presets'];
  /**
   * Parameters that are alternatives to one another.
   *
   * Carried through the draft for the reason every optional field here is: the inspector round trips,
   * and a field it does not carry is a field it deletes from any manifest it opens.
   */
  readonly exclusive?: readonly ExclusiveGroupDescriptor[];
}

/** An empty draft, for a graph that has just been loaded. */
export function emptyDraft(overrides: Partial<ManifestDraft> = {}): ManifestDraft {
  return {
    id: '',
    name: '',
    backend: 'comfyui',
    graph: null,
    produces: 'image',
    consumes: [],
    surfaces: [],
    duration: 'declared',
    defaultVariants: 1,
    requires: [],
    outputs: [],
    params: [],
    presets: [],
    ...overrides,
  };
}

/**
 * Parameter keys whose name alone determines the type.
 *
 * `seed` is the one that matters: getting it wrong silently disables variants, because the variant planner
 * looks for a parameter of type `seed` and finds an int instead. Naming it is worth the special case.
 */
const SEED_KEYS: readonly string[] = ['seed', 'noise_seed', 'rand_seed'];

/**
 * The type to offer for a literal before the user chooses.
 *
 * A suggestion the user can override, never a decision. It is inferred from the *value* the graph carries,
 * which is the only evidence available without a node schema.
 */
export function suggestType(literal: GraphLiteral): GeneratorParamType {
  if (SEED_KEYS.includes(literal.input)) return 'seed';
  if (typeof literal.value === 'boolean') return 'bool';
  if (typeof literal.value === 'number') return Number.isInteger(literal.value) ? 'int' : 'float';
  return 'text';
}

/** A key derived from the input name, unique within the draft. */
export function suggestKey(literal: GraphLiteral, taken: readonly string[]): string {
  const base = literal.input.replace(/[^a-z0-9_]+/gi, '_').toLowerCase() || 'param';
  if (!taken.includes(base)) return base;

  // Two nodes commonly share an input name — two `KSampler`s both have `steps`. Suffixing with the node id
  // keeps both bindable instead of silently dropping one.
  const withNode = `${base}_${literal.nodeId.replace(/[^a-z0-9]+/gi, '_')}`.toLowerCase();
  if (!taken.includes(withNode)) return withNode;

  let index = 2;
  while (taken.includes(`${withNode}_${index}`)) index += 1;
  return `${withNode}_${index}`;
}

/** Promotes a literal to a parameter, with everything the inspector can infer already filled in. */
export function promote(draft: ManifestDraft, literal: GraphLiteral): ManifestDraft {
  if (draft.params.some((param) => param.pointer === literal.pointer)) return draft;

  const type = suggestType(literal);
  const param: DraftParam = {
    // Pointers are unique within a graph, so one makes a good stable id for a promoted literal.
    id: literal.pointer,
    pointer: literal.pointer,
    key: suggestKey(
      literal,
      draft.params.map((existing) => existing.key),
    ),
    label: literal.input,
    type,
    // The graph's current value becomes the default, which is what makes a freshly written manifest run
    // exactly as the graph did. A seed is excluded: pinning it would make every run identical.
    ...(type === 'seed' ? {} : { default: literal.value }),
    ...(type === 'text' && typeof literal.value === 'string' && literal.value.includes('\n')
      ? { multiline: true }
      : {}),
  };

  return { ...draft, params: [...draft.params, param] };
}

/**
 * Adds a parameter with no graph binding.
 *
 * The spec's workflow for a manifest written before its graph: the contract is declared first and the
 * inspector fills in the pointers later. The id is derived from the existing ids rather than a counter or a
 * random value, so the same sequence of edits always produces the same draft.
 */
export function addParam(draft: ManifestDraft, param: Omit<DraftParam, 'id' | 'pointer'>): ManifestDraft {
  const taken = new Set(draft.params.map((existing) => existing.id));
  let index = draft.params.length + 1;
  while (taken.has(`param_${index}`)) index += 1;
  return { ...draft, params: [...draft.params, { ...param, id: `param_${index}`, pointer: '' }] };
}

/** Removes a parameter. The literal stays in the graph with whatever value it had. */
export function demote(draft: ManifestDraft, id: string): ManifestDraft {
  return { ...draft, params: draft.params.filter((param) => param.id !== id) };
}

/**
 * An edit to a parameter.
 *
 * Written out rather than using `Partial` so a property may be set to `undefined` explicitly. Under
 * `exactOptionalPropertyTypes` those are different things, and *clearing* a field is exactly what a user
 * does when they empty the min box — `prune` then drops it from the draft.
 */
export type DraftParamChanges = {
  readonly [K in keyof Omit<DraftParam, 'id'>]?: DraftParam[K] | undefined;
};

/** Edits one parameter, addressed by its stable id. */
export function editParam(draft: ManifestDraft, id: string, changes: DraftParamChanges): ManifestDraft {
  return {
    ...draft,
    params: draft.params.map((param) => (param.id === id ? prune({ ...param, ...changes }) : param)),
  };
}

/** Keys that carry the parameter's identity and binding. Never dropped, even when empty. */
const STRUCTURAL_KEYS: readonly string[] = ['id', 'pointer', 'key', 'type'];

/**
 * Drops keys the user cleared.
 *
 * A cleared range must vanish from the manifest — `"min": undefined` would serialize as `null` and the
 * schema would reject the file the inspector just wrote. An empty *pointer*, by contrast, is meaningful:
 * it is how an unbound parameter is expressed, so the structural keys are exempt.
 */
function prune(param: { readonly [key: string]: unknown }): DraftParam {
  const entries = Object.entries(param).filter(
    ([key, value]) => STRUCTURAL_KEYS.includes(key) || (value !== undefined && value !== ''),
  );
  return Object.fromEntries(entries) as unknown as DraftParam;
}

/** Declares a graph node as an output. */
export function addOutput(draft: ManifestDraft, output: OutputDescriptor): ManifestDraft {
  const existing = draft.outputs.filter((entry) => entry.key !== output.key);
  return { ...draft, outputs: [...existing, output] };
}

export type DraftIssueSeverity = 'error' | 'warning';

export interface DraftIssue {
  readonly severity: DraftIssueSeverity;
  /** JSON path into the draft, so the inspector can focus the offending field. */
  readonly path: string;
  readonly message: string;
}

/**
 * Everything wrong with a draft.
 *
 * Errors block writing the manifest; warnings do not. The split matters because a manifest is legitimately
 * written **before** its graph exists — the spec's TTS example — and the registry has an `unbound` status
 * precisely for that. Refusing to save an unbound draft would break the workflow the spec describes.
 */
export function validateDraft(draft: ManifestDraft): readonly DraftIssue[] {
  const issues: DraftIssue[] = [];
  const error = (path: string, message: string): void => {
    issues.push({ severity: 'error', path, message });
  };
  const warn = (path: string, message: string): void => {
    issues.push({ severity: 'warning', path, message });
  };

  if (draft.id.trim() === '') error('/id', 'an id is required');
  else if (!/^[a-z0-9_]+$/.test(draft.id)) {
    error('/id', 'the id may contain only lowercase letters, digits and underscores');
  }
  if (draft.name.trim() === '') error('/name', 'a name is required');
  if (draft.backend.trim() === '') error('/backend', 'a backend is required');

  const keys = new Set<string>();
  draft.params.forEach((param, index) => {
    const path = `/params/${index}`;
    if (param.key.trim() === '') error(`${path}/key`, 'a key is required');
    else if (keys.has(param.key)) error(`${path}/key`, `duplicate key "${param.key}"`);
    keys.add(param.key);

    if (param.min !== undefined && param.max !== undefined && param.min > param.max) {
      error(`${path}/min`, 'the minimum is above the maximum');
    }
    if (param.type === 'enum' && (param.options ?? []).length === 0) {
      error(`${path}/options`, 'an enum needs options');
    }
    if (param.pointer.trim() === '') {
      warn(`${path}/pointer`, 'this parameter is not bound to the graph yet');
    }
  });

  const seeds = draft.params.filter((param) => param.type === 'seed');
  if (seeds.length > 1) error('/params', 'only one seed parameter is meaningful');
  if (seeds.length === 0 && draft.defaultVariants > 1) {
    // Not an error: the manifest is still valid, it simply cannot do what its own default asks for.
    warn('/defaultVariants', 'without a seed parameter the variant count is forced to 1');
  }

  if (draft.outputs.length === 0) error('/outputs', 'at least one output is required');
  draft.outputs.forEach((output, index) => {
    if (output.node === null) warn(`/outputs/${index}/node`, 'this output is not bound to a node yet');
  });

  if (draft.surfaces.length === 0) {
    warn('/surfaces', 'with no surface declared the generator has no entry point in the UI');
  }
  if (draft.graph === null) warn('/graph', 'the graph is not connected yet');
  if (draft.batch !== undefined && draft.batch.max < 1)
    error('/batch/max', 'the batch size must be at least 1');

  return issues;
}

export function draftHasErrors(draft: ManifestDraft): boolean {
  return validateDraft(draft).some((issue) => issue.severity === 'error');
}

/**
 * Exactly the JSON that will be written.
 *
 * Separate from `toManifest` because it must survive a **half-finished** draft: the inspector previews the
 * file while the user is still typing the id, and a preview that threw would take the whole panel down at
 * the moment the user most needs to see what they are building. Nothing here validates — `validateDraft`
 * already reported every problem, and reporting them twice in two different ways helps no one.
 */
export function draftManifestJson(draft: ManifestDraft): Readonly<Record<string, unknown>> {
  return {
    id: draft.id,
    name: draft.name,
    backend: draft.backend,
    graph: draft.graph,
    produces: draft.produces,
    consumes: draft.consumes,
    surfaces: draft.surfaces,
    duration: draft.duration,
    ...(draft.durationFrom !== undefined ? { durationFrom: draft.durationFrom } : {}),
    defaultVariants: draft.defaultVariants,
    ...(draft.batch !== undefined ? { batch: draft.batch } : {}),
    requires: draft.requires,
    outputs: draft.outputs,
    params: draft.params.map(toParam),
    presets: draft.presets,
    ...(draft.exclusive !== undefined ? { exclusive: draft.exclusive } : {}),
    // Declared rather than inferred: a manifest whose pointers are still empty must land in the registry as
    // `unbound`, which is what greys it with "graph not connected" instead of reporting it as broken.
    ...(draft.graph === null || draft.params.some((param) => (param.pointer ?? '').trim() === '')
      ? { status: 'unbound' as const }
      : {}),
  };
}

/**
 * Writes the manifest.
 *
 * Returns the runtime shape rather than a JSON string so the caller can validate it against the registry
 * before it reaches disk — round-tripping through text first would only postpone finding out. The id is
 * branded here, which is where an invalid one should be rejected: at the boundary, on the way to disk.
 */
export function toManifest(draft: ManifestDraft): GeneratorManifest {
  return { ...draftManifestJson(draft), id: generatorId(draft.id) as GeneratorId } as GeneratorManifest;
}

function toParam(param: DraftParam): GeneratorParam {
  return {
    key: param.key,
    ...(param.label !== undefined ? { label: param.label } : {}),
    type: param.type,
    bind: (param.pointer ?? '').trim() === '' ? null : param.pointer,
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.step !== undefined ? { step: param.step } : {}),
    ...(param.default !== undefined ? { default: param.default } : {}),
    ...(param.options !== undefined ? { options: param.options } : {}),
    ...(param.required !== undefined ? { required: param.required } : {}),
    ...(param.multiline !== undefined ? { multiline: param.multiline } : {}),
    ...(param.transport !== undefined ? { transport: param.transport } : {}),
    ...(param.also !== undefined ? { also: param.also } : {}),
    ...(param.defaultFrom !== undefined ? { defaultFrom: param.defaultFrom } : {}),
  };
}

/** A draft recovered from an existing manifest, so an authored manifest can be edited rather than retyped. */
export function fromManifest(manifest: GeneratorManifest): ManifestDraft {
  return {
    id: manifest.id,
    name: manifest.name,
    backend: manifest.backend,
    graph: manifest.graph,
    produces: manifest.produces,
    consumes: manifest.consumes,
    surfaces: manifest.surfaces,
    duration: manifest.duration,
    ...(manifest.durationFrom !== undefined ? { durationFrom: manifest.durationFrom } : {}),
    defaultVariants: manifest.defaultVariants,
    ...(manifest.batch !== undefined ? { batch: manifest.batch } : {}),
    requires: manifest.requires,
    outputs: manifest.outputs,
    params: manifest.params.map((param, index) => ({
      // A bound parameter keeps its pointer as its id, so reopening a manifest and re-promoting the same
      // literal is idempotent rather than producing a duplicate.
      id: param.bind ?? `param_${index + 1}`,
      pointer: param.bind ?? '',
      key: param.key,
      ...(param.label !== undefined ? { label: param.label } : {}),
      type: param.type,
      ...(param.min !== undefined ? { min: param.min } : {}),
      ...(param.max !== undefined ? { max: param.max } : {}),
      ...(param.step !== undefined ? { step: param.step } : {}),
      ...(param.default !== undefined ? { default: param.default } : {}),
      ...(Array.isArray(param.options) ? { options: param.options } : {}),
      ...(param.required !== undefined ? { required: param.required } : {}),
      ...(param.multiline !== undefined ? { multiline: param.multiline } : {}),
      ...(param.transport !== undefined ? { transport: param.transport } : {}),
      ...(param.also !== undefined ? { also: param.also } : {}),
      ...(param.defaultFrom !== undefined ? { defaultFrom: param.defaultFrom } : {}),
    })),
    presets: manifest.presets,
    ...(manifest.exclusive !== undefined ? { exclusive: manifest.exclusive } : {}),
  };
}

/** Which preset ids a draft defines, for the inspector's preset editor. */
export function draftPresetIds(draft: ManifestDraft): readonly PresetId[] {
  return draft.presets.map((preset) => preset.id);
}
