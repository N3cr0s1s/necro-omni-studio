import { type EffectId, type ValidationIssue, formatIssues, validate } from '@nos/core';
import type {
  EffectShaderSource,
  EffectSourceResolver,
  EffectUniformDeclaration,
  EffectUniformType,
} from '@nos/compositor';
import {
  type AnyEffectManifest,
  type EffectParam,
  type EffectParamType,
  manifestLabel,
  normalizeManifestKeys,
  vAnyEffectManifest,
} from '../manifest/effect-manifest.js';

/**
 * The effect registry.
 *
 * Mirrors the spec's rule for the *generator* registry, applied to effects: an entry that cannot be used
 * is kept with a concrete reason rather than dropped. The spec's justification is explicit — "where is my
 * tool" debugging costs hours — and it applies identically here. A manifest with a typo shows greyed out
 * saying what is wrong, instead of an effect that silently is not in the menu.
 */

export type EffectStatus = 'available' | 'invalid' | 'missing-shader';

/** An entry in the registry, usable or not. */
export type EffectEntry =
  | {
      readonly status: 'available';
      readonly id: EffectId;
      readonly manifest: AnyEffectManifest;
      readonly source: EffectShaderSource;
    }
  | {
      readonly status: 'invalid';
      /** Present when the id could be read despite the manifest being broken. */
      readonly id: EffectId | undefined;
      /** Where the manifest came from, so the user can find and fix it. */
      readonly origin: string;
      readonly issues: readonly ValidationIssue[];
    }
  | {
      readonly status: 'missing-shader';
      readonly id: EffectId;
      readonly manifest: AnyEffectManifest;
      readonly origin: string;
      readonly shader: string;
    };

export interface EffectRegistry extends EffectSourceResolver {
  /** Every entry, usable or not, for the "add effect" menu. */
  entries(): readonly EffectEntry[];
  /** Only the entries that can actually render. */
  available(): readonly Extract<EffectEntry, { status: 'available' }>[];
  /** Entries that failed, for the inspector's problem list. */
  problems(): readonly Exclude<EffectEntry, { status: 'available' }>[];
  find(id: EffectId): EffectEntry | undefined;
  manifestFor(id: EffectId): AnyEffectManifest | undefined;
}

/** A manifest as read from disk, before validation. */
export interface RawManifest {
  /** Path or label identifying where this came from, used in error messages. */
  readonly origin: string;
  readonly json: unknown;
  /**
   * Shader text, resolved by the loader.
   *
   * Passed in rather than read here because the registry must work in the renderer (where files arrive
   * over the sidecar) and in tests (where they are inline strings).
   */
  readonly shaderSource: string | undefined;
}

/**
 * Builds a registry from raw manifests.
 *
 * Validation is total: every manifest is checked and a failure produces an entry, never an exception. One
 * broken file in a project's `effects/` folder must not prevent the other nine from loading.
 */
export function createEffectRegistry(manifests: readonly RawManifest[]): EffectRegistry {
  const entries: EffectEntry[] = [];
  const byId = new Map<string, EffectEntry>();

  for (const raw of manifests) {
    const parsed = validate(vAnyEffectManifest, normalizeManifestKeys(raw.json));

    if (!parsed.ok) {
      entries.push({
        status: 'invalid',
        id: readIdLoosely(raw.json),
        origin: raw.origin,
        issues: parsed.error,
      });
      continue;
    }

    const manifest = parsed.value;

    if (raw.shaderSource === undefined) {
      entries.push({
        status: 'missing-shader',
        id: manifest.id,
        manifest,
        origin: raw.origin,
        shader: manifest.shader,
      });
      continue;
    }

    entries.push({
      status: 'available',
      id: manifest.id,
      manifest,
      source: toShaderSource(manifest, raw.shaderSource),
    });
  }

  // Later entries win on a duplicate id, so a project-local effect can override a built-in of the same
  // name — the same precedence the spec gives project generators over the global library.
  for (const entry of entries) {
    if (entry.id !== undefined) byId.set(entry.id, entry);
  }

  return {
    resolve(id: EffectId): EffectShaderSource | undefined {
      const entry = byId.get(id);
      return entry?.status === 'available' ? entry.source : undefined;
    },
    entries: () => entries,
    available: () =>
      entries.filter(
        (entry): entry is Extract<EffectEntry, { status: 'available' }> => entry.status === 'available',
      ),
    problems: () =>
      entries.filter(
        (entry): entry is Exclude<EffectEntry, { status: 'available' }> => entry.status !== 'available',
      ),
    find: (id) => byId.get(id),
    manifestFor: (id) => {
      const entry = byId.get(id);
      return entry === undefined || entry.status === 'invalid' ? undefined : entry.manifest;
    },
  };
}

/**
 * Reads an id from a manifest that failed validation.
 *
 * Best-effort on purpose: knowing *which* effect is broken is far more useful than an anonymous error,
 * and the id is usually the one field that is fine.
 */
function readIdLoosely(json: unknown): EffectId | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const id = (json as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() !== '' ? (id.trim() as EffectId) : undefined;
}

/** GLSL type for each manifest parameter type. */
const GLSL_TYPES: Readonly<Record<EffectParamType, EffectUniformType>> = {
  float: 'float',
  int: 'int',
  bool: 'bool',
  // A colour is RGBA, so it needs four components even though the manifest calls it `color`.
  color: 'vec4',
  vec2: 'vec2',
};

function toUniformDeclaration(param: EffectParam): EffectUniformDeclaration {
  return {
    name: param.uniform,
    type: GLSL_TYPES[param.type],
    // Carried explicitly even when identical, so the compositor never has to guess.
    paramKey: param.key,
  };
}

/**
 * Projects a manifest onto what the compositor needs.
 *
 * The narrow shape is the point: the compositor gets shader text, samplers and typed uniforms, and knows
 * nothing about labels, ranges or groups. That is what lets the manifest format grow — a new UI field
 * cannot affect the render path.
 */
export function toShaderSource(manifest: AnyEffectManifest, shaderSource: string): EffectShaderSource {
  const uniforms = manifest.params.map(toUniformDeclaration);

  if (manifest.category === 'transition') {
    return {
      id: manifest.id,
      category: 'transition',
      source: shaderSource,
      samplers: manifest.samplers,
      uniforms,
      ...(manifest.convention !== undefined ? { convention: manifest.convention } : {}),
      ...(manifest.progressUniform !== undefined ? { progressUniform: manifest.progressUniform } : {}),
      // A ported shader declares its own uniforms; one authored here relies on the generated
      // declarations. The convention flag is the only reliable signal available.
      ...(manifest.convention === 'gl-transitions' ? { declaresOwnUniforms: true } : {}),
    };
  }

  return {
    id: manifest.id,
    category: 'effect',
    source: shaderSource,
    samplers: manifest.samplers,
    uniforms,
  };
}

/**
 * Default parameter values for a newly added effect instance.
 *
 * Derived from the manifest so adding an effect produces a working instance immediately. A parameter with
 * no declared default falls back to a neutral value for its type rather than being omitted — an absent
 * uniform reads as zero in GLSL, which for a `scale`-like parameter means the picture disappears.
 */
export function defaultParams(
  manifest: AnyEffectManifest,
): Readonly<Record<string, number | boolean | readonly number[]>> {
  const params: Record<string, number | boolean | readonly number[]> = {};

  for (const param of manifest.params) {
    if (param.default !== undefined) {
      params[param.key] = param.default;
      continue;
    }
    switch (param.type) {
      case 'bool':
        params[param.key] = false;
        break;
      case 'color':
        params[param.key] = [1, 1, 1, 1];
        break;
      case 'vec2':
        params[param.key] = [0, 0];
        break;
      default:
        // Midpoint of the declared range when there is one, otherwise zero: a range implies the
        // author has an opinion about the useful span, and its middle is a safer starting point than
        // an endpoint.
        params[param.key] =
          param.min !== undefined && param.max !== undefined ? (param.min + param.max) / 2 : 0;
        break;
    }
  }

  return params;
}

/** One-line summary of a registry problem, for a log or a tooltip. */
export function describeEntryProblem(entry: Exclude<EffectEntry, { status: 'available' }>): string {
  if (entry.status === 'missing-shader') {
    return `${manifestLabel(entry.manifest)}: shader "${entry.shader}" was not found (${entry.origin})`;
  }
  const label = entry.id ?? entry.origin;
  return `${label}: ${formatIssues(entry.issues)}`;
}
