import type { PresetId } from '@nos/core';
import {
  type GeneratorManifest,
  type GeneratorParam,
  type GraphLiteral,
  applyTemplate,
  patchPointer,
} from '@nos/generators';

export type { GraphLiteral };

/**
 * Graph patching.
 *
 * The runner "knows nothing about the nodes — only graph patching and endpoint calls", as the spec puts it.
 * This module is the patching half, and it is pure: manifest plus parameters in, a new graph out. That
 * makes it testable against the real supplied graphs with no ComfyUI running, which is where nearly all of
 * the risk in this layer lives.
 *
 * Patch order matters and is fixed:
 *
 *   1. Parameter defaults, so an unset parameter still has its declared value.
 *   2. User-supplied values.
 *   3. **Preset pins last**, because a preset's whole purpose is to fix a parameter — letting a stale user
 *      value win would make the preset a suggestion rather than a definition.
 *   4. The seed, which the queue owns because variants come from varying it.
 *   5. Batch size, when the graph supports it.
 */

export interface PatchResult {
  readonly graph: unknown;
  /** Assets the backend must upload before submitting. */
  readonly assets: readonly PatchAsset[];
  /** The values actually written, for recording on the job for reproducibility. */
  readonly appliedParams: Readonly<Record<string, string | number | boolean>>;
}

export interface PatchAsset {
  readonly key: string;
  readonly path: string;
  readonly transport: string;
}

export interface PatchRequest {
  readonly manifest: GeneratorManifest;
  readonly graph: unknown;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly preset?: PresetId;
  /** Seeds for this submit. More than one only in batched mode. */
  readonly seeds: readonly number[];
}

export class PatchError extends Error {
  constructor(
    message: string,
    readonly paramKey: string,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

export function patchGraph(request: PatchRequest): PatchResult {
  const { manifest, params, seeds } = request;

  const preset =
    request.preset === undefined
      ? undefined
      : manifest.presets.find((candidate) => candidate.id === request.preset);

  // Layered so the precedence above is explicit rather than emergent from iteration order.
  const values: Record<string, string | number | boolean> = {};
  for (const param of manifest.params) {
    if (param.default !== undefined) values[param.key] = param.default;
  }
  Object.assign(values, params);
  if (preset !== undefined) Object.assign(values, preset.pin);

  const seedKey = manifest.params.find((param) => param.type === 'seed')?.key;
  const primarySeed = seeds[0];
  if (seedKey !== undefined && primarySeed !== undefined) {
    values[seedKey] = primarySeed;
  }

  let graph = request.graph;
  const assets: PatchAsset[] = [];

  for (const param of manifest.params) {
    const value = values[param.key];
    if (value === undefined) {
      // A required parameter with nothing to write would submit a graph that silently uses whatever the
      // author last saved, which is far worse than refusing.
      if (param.required === true) {
        throw new PatchError(`the required parameter "${param.key}" has no value`, param.key);
      }
      continue;
    }

    if (isAssetParam(param)) {
      // Asset parameters are patched with the *uploaded filename*, which only exists after upload — so the
      // backend records the intent here and rewrites the pointer once the upload returns.
      assets.push({
        key: param.key,
        path: String(value),
        transport: param.transport ?? 'upload_image',
      });
      continue;
    }

    graph = patchParam(graph, param, value, values);
  }

  if (manifest.batch !== undefined && seeds.length > 1) {
    graph = patchPointer(graph, manifest.batch.bind, seeds.length);
  }

  return { graph, assets, appliedParams: values };
}

/**
 * Writes one parameter to its primary pointer and every `also` target.
 *
 * The `also` mechanism is why this cannot be a single write. The spec's example is `fps`, which is both a
 * literal input and part of a length-calculation expression; patching only the literal leaves the
 * expression computing from a stale rate and produces a clip of the wrong duration — a bug that looks like
 * a backend problem and is not.
 */
function patchParam(
  graph: unknown,
  param: GeneratorParam,
  value: string | number | boolean,
  allValues: Readonly<Record<string, string | number | boolean>>,
): unknown {
  let patched = graph;

  if (param.bind !== null) {
    patched = patchPointer(patched, param.bind, value);
  }

  for (const also of param.also ?? []) {
    const written =
      also.template === undefined ? value : applyTemplate(also.template, allValues);
    patched = patchPointer(patched, also.pointer, written);
  }

  return patched;
}

function isAssetParam(param: GeneratorParam): boolean {
  return (
    param.type === 'image' || param.type === 'video' || param.type === 'audio' || param.type === 'mask'
  );
}

/**
 * Rewrites an asset parameter once its upload has returned a backend-side filename.
 *
 * Separate from `patchGraph` because uploads are asynchronous and network-bound while patching is pure.
 * Keeping the pure part pure is what allows the whole patch to be verified against the real graphs offline.
 */
export function patchUploadedAsset(
  graph: unknown,
  manifest: GeneratorManifest,
  key: string,
  uploadedFilename: string,
): unknown {
  const param = manifest.params.find((candidate) => candidate.key === key);
  if (param === undefined || param.bind === null) return graph;
  return patchPointer(graph, param.bind, uploadedFilename);
}

/**
 * Reads a literal currently in the graph.
 *
 * Used by the manifest inspector, which lists node inputs and their existing values so the user can pick
 * which become parameters — the spec's "we do not write manifests by hand" workflow.
 */
export function readLiteral(graph: unknown, pointer: string): unknown {
  const segments = pointer.replace(/^\//, '').split('/');
  let current: unknown = graph;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Every literal input in a graph, for the manifest inspector.
 *
 * Connections — inputs whose value is an array of `[nodeId, slot]` — are excluded, because they are wired
 * to another node and cannot be a parameter. Offering them would produce manifests that patch a value the
 * graph immediately overwrites.
 */
export function collectLiterals(graph: unknown): readonly GraphLiteral[] {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) return [];

  const literals: GraphLiteral[] = [];

  for (const [nodeId, node] of Object.entries(graph as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object') continue;
    const record = node as { inputs?: unknown; class_type?: unknown };
    if (record.inputs === null || typeof record.inputs !== 'object') continue;

    const nodeClass = typeof record.class_type === 'string' ? record.class_type : 'unknown';

    for (const [input, value] of Object.entries(record.inputs as Record<string, unknown>)) {
      // An array value is a connection to another node's output slot, not a literal.
      if (Array.isArray(value)) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        continue;
      }
      literals.push({
        pointer: `/${nodeId}/inputs/${input}`,
        nodeId,
        nodeClass,
        input,
        value,
      });
    }
  }

  return literals;
}
