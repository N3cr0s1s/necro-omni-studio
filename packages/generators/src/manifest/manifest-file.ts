import {
  type AssetType,
  type Validated,
  type ValidationIssue,
  type Validator,
  childPath,
  err,
  generatorId,
  issue,
  ok,
  presetId,
  vArray,
  vBoolean,
  vEnum,
  vNumber,
  vObject,
  vOptional,
  vString,
  vWithDefault,
  validate,
} from '@nos/core';
import type {
  AlsoBinding,
  BatchDescriptor,
  CapabilityOptions,
  ConsumesDescriptor,
  GeneratorManifest,
  GeneratorParam,
  GeneratorParamType,
  GeneratorPreset,
  ManifestStatus,
  OutputDescriptor,
} from '../contracts/manifest.js';
import { PARAM_TYPES } from '../contracts/manifest.js';
import type { ManifestDraft } from './manifest-draft.js';
import { draftManifestJson } from './manifest-draft.js';

/**
 * Manifest files.
 *
 * The on-disk form is the one the spec prints: **snake_case**, because these files are written and read by
 * people, sit in `generators/` next to the graphs, and are diffed in a review. The runtime form is
 * camelCase, because that is what TypeScript reads like. This module is the only place that knows both,
 * which is what keeps the naming choice from leaking into either side.
 *
 * Parsing is total: it returns every problem with a JSON path rather than throwing on the first. A user
 * authoring a manifest by hand — the spec allows it even though the inspector exists — should see all four
 * mistakes at once, not four reload cycles.
 */

const vAssetType = vEnum<AssetType>(['video', 'audio', 'image', 'mask', 'text']);
const vParamType = vEnum<GeneratorParamType>(PARAM_TYPES);
const vStatus = vEnum<ManifestStatus>(['available', 'unavailable', 'unbound']);

/** A pointer, or `null` for a parameter whose graph does not exist yet. */
const vPointerOrNull: Validator<string | null> = (value, path) =>
  value === null ? ok(null) : vString(value, path);

const vAlso: Validator<AlsoBinding> = vObject<AlsoBinding>({
  pointer: vString,
  template: vOptional(vString),
});

const vCapabilityOptions: Validator<CapabilityOptions> = (value, path) => {
  const shape = vObject<{ from: 'capabilities'; node_class?: string; input?: string }>({
    from: vEnum(['capabilities']),
    node_class: vOptional(vString),
    input: vOptional(vString),
  })(value, path);
  if (!shape.ok) return shape;

  return ok({
    from: 'capabilities',
    ...(shape.value.node_class !== undefined ? { nodeClass: shape.value.node_class } : {}),
    ...(shape.value.input !== undefined ? { input: shape.value.input } : {}),
  });
};

/** Static list or live lookup. Tried in that order because an array is unambiguous. */
const vOptions: Validator<readonly string[] | CapabilityOptions> = (value, path) =>
  Array.isArray(value) ? vArray(vString)(value, path) : vCapabilityOptions(value, path);

const vScalar: Validator<string | number | boolean> = (value, path) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? ok(value)
    : err([issue(path, 'expected a string, number or boolean')]);

function parseParam(value: unknown, path: string): Validated<GeneratorParam> {
  const shape = vObject<{
    key: string;
    label?: string;
    type: GeneratorParamType;
    bind: string | null;
    also?: readonly AlsoBinding[];
    multiline?: boolean;
    min?: number;
    max?: number;
    step?: number;
    default?: string | number | boolean;
    options?: readonly string[] | CapabilityOptions;
    required?: boolean;
    transport?: string;
    default_from?: string;
  }>({
    key: vString,
    label: vOptional(vString),
    type: vParamType,
    bind: vPointerOrNull,
    also: vOptional(vArray(vAlso)),
    multiline: vOptional(vBoolean),
    min: vOptional(vNumber),
    max: vOptional(vNumber),
    step: vOptional(vNumber),
    default: vOptional(vScalar),
    options: vOptional(vOptions),
    required: vOptional(vBoolean),
    transport: vOptional(vString),
    default_from: vOptional(vString),
  })(value, path);

  if (!shape.ok) return shape;
  const parsed = shape.value;

  return ok({
    key: parsed.key,
    ...(parsed.label !== undefined ? { label: parsed.label } : {}),
    type: parsed.type,
    bind: parsed.bind,
    ...(parsed.also !== undefined ? { also: parsed.also } : {}),
    ...(parsed.multiline !== undefined ? { multiline: parsed.multiline } : {}),
    ...(parsed.min !== undefined ? { min: parsed.min } : {}),
    ...(parsed.max !== undefined ? { max: parsed.max } : {}),
    ...(parsed.step !== undefined ? { step: parsed.step } : {}),
    ...(parsed.default !== undefined ? { default: parsed.default } : {}),
    ...(parsed.options !== undefined ? { options: parsed.options } : {}),
    ...(parsed.required !== undefined ? { required: parsed.required } : {}),
    ...(parsed.transport !== undefined ? { transport: parsed.transport } : {}),
    ...(parsed.default_from !== undefined ? { defaultFrom: parsed.default_from } : {}),
  });
}

function parseConsumes(value: unknown, path: string): Validated<ConsumesDescriptor> {
  const shape = vObject<{
    type: AssetType;
    role?: string;
    required?: boolean;
    sources?: readonly string[];
  }>({
    type: vAssetType,
    role: vOptional(vString),
    required: vOptional(vBoolean),
    sources: vOptional(vArray(vString)),
  })(value, path);
  if (!shape.ok) return shape;

  return ok({
    type: shape.value.type,
    ...(shape.value.role !== undefined ? { role: shape.value.role } : {}),
    ...(shape.value.required !== undefined ? { required: shape.value.required } : {}),
    ...(shape.value.sources !== undefined ? { sources: shape.value.sources } : {}),
  });
}

function parseOutput(value: unknown, path: string): Validated<OutputDescriptor> {
  const shape = vObject<{
    key: string;
    type: AssetType;
    node: string | null;
    optional?: boolean;
    format?: string;
  }>({
    key: vString,
    type: vAssetType,
    node: vPointerOrNull,
    optional: vOptional(vBoolean),
    format: vOptional(vString),
  })(value, path);
  if (!shape.ok) return shape;

  return ok({
    key: shape.value.key,
    type: shape.value.type,
    node: shape.value.node,
    ...(shape.value.optional !== undefined ? { optional: shape.value.optional } : {}),
    ...(shape.value.format !== undefined ? { format: shape.value.format } : {}),
  });
}

function parsePreset(value: unknown, path: string): Validated<GeneratorPreset> {
  const vValueMap =
    (what: string) =>
    (raw: unknown, at: string): Validated<Readonly<Record<string, unknown>>> =>
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? ok(raw as Readonly<Record<string, unknown>>)
        : err([issue(at, `expected an object of ${what}`)]);

  const shape = vObject<{
    id: string;
    name: string;
    pin: Readonly<Record<string, unknown>>;
    set?: Readonly<Record<string, unknown>>;
  }>({
    id: vString,
    name: vString,
    pin: vValueMap('pinned values'),
    set: vOptional(vValueMap('starting values')),
  })(value, path);
  if (!shape.ok) return shape;

  const issues: ValidationIssue[] = [];

  const scalars = (
    source: Readonly<Record<string, unknown>>,
    field: string,
  ): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};
    for (const [key, raw] of Object.entries(source)) {
      const scalar = vScalar(raw, childPath(childPath(path, field), key));
      if (scalar.ok) out[key] = scalar.value;
      else issues.push(...scalar.error);
    }
    return out;
  };

  const pin = scalars(shape.value.pin, 'pin');
  const set = shape.value.set === undefined ? undefined : scalars(shape.value.set, 'set');
  if (issues.length > 0) return err(issues);

  return ok({
    id: presetId(shape.value.id),
    name: shape.value.name,
    pin,
    ...(set !== undefined ? { set } : {}),
  });
}

const vBatch: Validator<BatchDescriptor> = vObject<BatchDescriptor>({
  bind: vString,
  max: vNumber,
});

/** The file's shape, in the names the file uses. */
interface ManifestFileShape {
  id: string;
  name: string;
  backend: string;
  graph: string | null;
  status?: ManifestStatus;
  produces: AssetType;
  consumes: readonly ConsumesDescriptor[];
  surfaces: readonly string[];
  duration: 'declared' | 'discovered';
  duration_from?: { param: string; unit: 'seconds' | 'frames' };
  default_variants: number;
  batch?: BatchDescriptor;
  requires: readonly string[];
  outputs: readonly OutputDescriptor[];
  params: readonly GeneratorParam[];
  presets: readonly GeneratorPreset[];
}

const vManifestFile = vObject<ManifestFileShape>({
  id: vString,
  name: vString,
  // Defaulted rather than required: every manifest in this project targets ComfyUI, and a field whose value
  // is always the same is a field people forget and then have to debug.
  backend: vWithDefault(vString, 'comfyui'),
  graph: vPointerOrNull,
  status: vOptional(vStatus),
  produces: vAssetType,
  consumes: vWithDefault(vArray(parseConsumes), []),
  surfaces: vWithDefault(vArray(vString), []),
  duration: vWithDefault(vEnum(['declared', 'discovered']), 'declared'),
  duration_from: vOptional(
    vObject<{ param: string; unit: 'seconds' | 'frames' }>({
      param: vString,
      unit: vWithDefault(vEnum(['seconds', 'frames']), 'seconds'),
    }),
  ),
  default_variants: vWithDefault(vNumber, 1),
  batch: vOptional(vBatch),
  requires: vWithDefault(vArray(vString), []),
  outputs: vWithDefault(vArray(parseOutput), []),
  params: vWithDefault(vArray(parseParam), []),
  presets: vWithDefault(vArray(parsePreset), []),
});

/**
 * Parses a manifest file.
 *
 * Note what is *not* checked here: whether the pointers resolve, whether the node classes are installed,
 * whether the output nodes exist. Those need a graph and a backend, and they belong to the registry, which
 * reports them as a status with a reason rather than as a parse failure. A manifest whose graph is missing
 * must still load — that is the whole point of the `unbound` status.
 */
export function parseManifestFile(value: unknown): Validated<GeneratorManifest> {
  const parsed = validate(vManifestFile, value);
  if (!parsed.ok) return parsed;

  const file = parsed.value;
  if (file.id.trim() === '') return err([issue('/id', 'an id is required')]);

  return ok({
    id: generatorId(file.id),
    name: file.name.trim() === '' ? file.id : file.name,
    backend: file.backend,
    graph: file.graph,
    ...(file.status !== undefined ? { status: file.status } : {}),
    produces: file.produces,
    consumes: file.consumes,
    surfaces: file.surfaces,
    duration: file.duration,
    ...(file.duration_from !== undefined ? { durationFrom: file.duration_from } : {}),
    defaultVariants: file.default_variants,
    ...(file.batch !== undefined ? { batch: file.batch } : {}),
    requires: file.requires,
    outputs: file.outputs,
    params: file.params,
    presets: file.presets,
  });
}

/**
 * Writes a manifest back out in the file's own naming.
 *
 * Round-tripping matters more than it looks: the inspector opens hand-written files, and a save that
 * renamed `default_variants` to `defaultVariants` would silently reset the count to 1 on the next load.
 */
export function serializeManifest(manifest: GeneratorManifest): Readonly<Record<string, unknown>> {
  return {
    id: manifest.id,
    name: manifest.name,
    backend: manifest.backend,
    graph: manifest.graph,
    ...(manifest.status !== undefined ? { status: manifest.status } : {}),
    produces: manifest.produces,
    consumes: manifest.consumes,
    surfaces: manifest.surfaces,
    duration: manifest.duration,
    ...(manifest.durationFrom !== undefined ? { duration_from: manifest.durationFrom } : {}),
    default_variants: manifest.defaultVariants,
    ...(manifest.batch !== undefined ? { batch: manifest.batch } : {}),
    requires: manifest.requires,
    outputs: manifest.outputs,
    params: manifest.params.map(serializeParam),
    presets: manifest.presets,
  };
}

function serializeParam(param: GeneratorParam): Readonly<Record<string, unknown>> {
  const options =
    param.options !== undefined && !Array.isArray(param.options)
      ? serializeCapabilityOptions(param.options as CapabilityOptions)
      : param.options;

  return {
    key: param.key,
    ...(param.label !== undefined ? { label: param.label } : {}),
    type: param.type,
    bind: param.bind,
    ...(param.also !== undefined ? { also: param.also } : {}),
    ...(param.multiline !== undefined ? { multiline: param.multiline } : {}),
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.step !== undefined ? { step: param.step } : {}),
    ...(param.default !== undefined ? { default: param.default } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(param.required !== undefined ? { required: param.required } : {}),
    ...(param.transport !== undefined ? { transport: param.transport } : {}),
    ...(param.defaultFrom !== undefined ? { default_from: param.defaultFrom } : {}),
  };
}

function serializeCapabilityOptions(options: CapabilityOptions): Readonly<Record<string, unknown>> {
  return {
    from: 'capabilities',
    ...(options.nodeClass !== undefined ? { node_class: options.nodeClass } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  };
}

/** The file the inspector writes, in the file's naming. */
export function draftToFile(draft: ManifestDraft): Readonly<Record<string, unknown>> {
  return serializeManifest(draftManifestJson(draft) as unknown as GeneratorManifest);
}
