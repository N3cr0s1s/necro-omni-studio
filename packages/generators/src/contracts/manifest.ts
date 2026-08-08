import type { AssetType, GeneratorId, PresetId } from '@nos/core';

/**
 * Generator manifests.
 *
 * This is the spec's most important architectural element. The application knows **no model, no graph, no
 * node class and no generator**: every generative capability — video, audio, image, upscale, transcript,
 * and whatever comes later — attaches through this one declaration. Adding a capability is a JSON file,
 * never code.
 *
 * The consequence that shapes everything below: a manifest declares what it **consumes and produces**,
 * not what it "is". The UI derives where an action appears from that pair, so text-to-speech and video
 * generation need no special cases anywhere — they differ only in their descriptors.
 */

/** Where a graph runs. `comfyui` is the only v1 implementation; the field exists so it is not the last. */
export type BackendId = string;

/**
 * A pointer into a backend graph.
 *
 * JSON-Pointer-like, e.g. `/52:31/inputs/value`. Deliberately opaque here: the manifest layer validates
 * that a pointer *resolves*, never what it means. Interpreting it is the backend's job, which is what
 * keeps a second backend from requiring changes to this package.
 */
export type GraphPointer = string;

export const PARAM_TYPES = [
  'text',
  'int',
  'float',
  'bool',
  'enum',
  'seed',
  'image',
  'video',
  'audio',
  'mask',
] as const;

export type GeneratorParamType = (typeof PARAM_TYPES)[number];

/**
 * A secondary patch target.
 *
 * The spec's `also` mechanism: one parameter value can need writing to several places, sometimes through a
 * string template. Its example is `fps`, which appears both as a literal and inside a length-calculation
 * expression — a single pointer would silently leave the expression stale, producing a clip of the wrong
 * duration.
 */
export interface AlsoBinding {
  readonly pointer: GraphPointer;
  /** `{key}` placeholders are substituted with parameter values. Absent means write the value directly. */
  readonly template?: string;
}

/** Options sourced live from the backend, so model and sampler lists reflect reality. */
export interface CapabilityOptions {
  readonly from: 'capabilities';
  readonly nodeClass?: string;
  readonly input?: string;
}

export interface GeneratorParam {
  readonly key: string;
  readonly label?: string;
  readonly type: GeneratorParamType;
  /** Where the value is patched into the graph. `null` for an unbound manifest. */
  readonly bind: GraphPointer | null;
  readonly also?: readonly AlsoBinding[];
  readonly multiline?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly default?: string | number | boolean;
  /**
   * A default the *application* supplies, named by what it derives from.
   *
   * For anything whose sensible value depends on the project rather than the graph. The example that
   * forced it: a generator's output aspect: 1:1 in a 16:9 sequence is pillarboxed the moment it
   * lands on the timeline, and a manifest cannot know the sequence. Resolved by
   * `resolveDerivedDefault`; a value the manifest also declares is the fallback when it cannot be.
   */
  readonly defaultFrom?: string;
  /** Static list, or a live one from the backend. */
  readonly options?: readonly string[] | CapabilityOptions;
  readonly required?: boolean;
  /** How an asset parameter reaches the backend, e.g. `upload_image`. */
  readonly transport?: string;
}

/** What a generator accepts as input. */
export interface ConsumesDescriptor {
  readonly type: AssetType;
  /**
   * What the input means, e.g. `first_frame`, `script`, `voice_reference`.
   *
   * The role is what makes a capability placeable: the same node class serves text-to-video and
   * image-to-video, so the difference cannot be inferred from the graph and must be declared.
   */
  readonly role?: string;
  readonly required?: boolean;
  /** Where a text input may come from: `inline`, `notes_file`, `text_clip`. */
  readonly sources?: readonly string[];
}

/** Surfaces where a generator's action appears. Derived from consumes/produces, listed explicitly. */
export type SurfaceId = string;

/** An output the graph produces. */
export interface OutputDescriptor {
  readonly key: string;
  readonly type: AssetType;
  /** Graph node the output comes from. `null` for an unbound manifest. */
  readonly node: string | null;
  readonly optional?: boolean;
  /** e.g. `word_timings` for a TTS alignment output. */
  readonly format?: string;
}

/**
 * Batch capability.
 *
 * Present only when the graph can produce several variants in one submit. Absent means the runner falls
 * back to sequential runs — which works on *any* graph, and is why batch is not the default.
 */
export interface BatchDescriptor {
  readonly bind: GraphPointer;
  readonly max: number;
}

/**
 * A preset appears as its own entry in the UI and brings values with it.
 *
 * Two kinds, and the distinction is the whole point. **Pinned** values are what make the preset *be*
 * that preset — the category that makes SFX SFX — so they are fixed and hidden, and the preset reads
 * as its own tool rather than the same form with different numbers. **Set** values are a starting
 * point the user is expected to change.
 *
 * The distinction was missing, so every preset value was a lock. A one-shot preset that pinned its
 * length left no way to ask for a slightly longer one: the control was gone, not merely pre-filled.
 * A preset should say "start here", and only say "always this" about the thing that defines it.
 */
export interface GeneratorPreset {
  readonly id: PresetId;
  readonly name: string;
  /** Fixed and hidden: the values that constitute the preset. */
  readonly pin: Readonly<Record<string, string | number | boolean>>;
  /** Pre-filled and editable: a starting point, still shown as a control. */
  readonly set?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * How the output length is known.
 *
 * `declared` means a parameter determines it, so a placeholder can be sized before the job runs.
 * `discovered` means only the output reveals it — text-to-speech, stem separation — and the spec fixes a
 * different insertion rule for that case: the clip lands from the playhead and later clips must **not**
 * shift, because a narration should never rearrange a video cut.
 */
export type DurationMode = 'declared' | 'discovered';

/** Registry status, as the spec defines it. */
export type ManifestStatus = 'available' | 'unavailable' | 'unbound';

export interface GeneratorManifest {
  readonly id: GeneratorId;
  readonly name: string;
  readonly backend: BackendId;
  /** Graph filename, or `null` for a contract written before its graph exists. */
  readonly graph: string | null;
  /** Declared by a manifest that knows it is not yet runnable. */
  readonly status?: ManifestStatus;

  readonly produces: AssetType;
  readonly consumes: readonly ConsumesDescriptor[];
  readonly surfaces: readonly SurfaceId[];

  readonly duration: DurationMode;
  /**
   * Which parameter carries the declared length, for sizing a placeholder before the job runs.
   *
   * Optional: when absent, a documented key convention is used so the manifests printed in the spec size
   * correctly unchanged. See `durationSource` in `staging/placeholder.ts`.
   */
  readonly durationFrom?: { readonly param: string; readonly unit: 'seconds' | 'frames' };
  readonly defaultVariants: number;
  readonly batch?: BatchDescriptor;

  /** Node classes the backend must have installed. Checked against `capabilities()`. */
  readonly requires: readonly string[];
  readonly outputs: readonly OutputDescriptor[];
  readonly params: readonly GeneratorParam[];
  readonly presets: readonly GeneratorPreset[];
}

/** The parameter that drives variant generation, if the manifest has one. */
export function seedParam(manifest: GeneratorManifest): GeneratorParam | undefined {
  return manifest.params.find((param) => param.type === 'seed');
}

/**
 * Whether a manifest can produce more than one variant.
 *
 * The spec's constraint: variants are made by varying the seed, so without a seed parameter the count is
 * forced to one — and the UI must say *why*, rather than silently returning identical results.
 */
export function supportsVariants(manifest: GeneratorManifest): boolean {
  return seedParam(manifest) !== undefined;
}

/** Whether the graph can produce variants in a single submit. */
export function supportsBatch(manifest: GeneratorManifest): boolean {
  return manifest.batch !== undefined;
}

/** Inputs that must be supplied before a run can start. */
export function requiredInputs(manifest: GeneratorManifest): readonly ConsumesDescriptor[] {
  return manifest.consumes.filter((descriptor) => descriptor.required === true);
}

/**
 * Whether a manifest is a contract without a graph.
 *
 * The spec's TTS example: the manifest is written first, the registry lists it as `unbound`, and the UI
 * greys it out saying the graph is not connected. When the graph arrives the inspector fills in the
 * pointers and nothing else about the contract changes.
 */
export function isUnbound(manifest: GeneratorManifest): boolean {
  if (manifest.status === 'unbound') return true;
  if (manifest.graph === null) return true;
  return manifest.params.some((param) => param.bind === null);
}

/** Display label, falling back to the id. */
export function manifestLabel(manifest: GeneratorManifest): string {
  return manifest.name.trim() === '' ? manifest.id : manifest.name;
}

/**
 * Every UI entry a manifest contributes.
 *
 * A manifest with presets contributes one entry per preset rather than one for itself: the spec's audio
 * example becomes four tools — music, instrumental, SFX, one-shot — from one graph, and the registry
 * indexes each separately so the job can record which was used.
 */
export interface GeneratorEntry {
  readonly generator: GeneratorId;
  readonly preset?: PresetId;
  readonly label: string;
  readonly surfaces: readonly SurfaceId[];
}

export function entriesFor(manifest: GeneratorManifest): readonly GeneratorEntry[] {
  // Defensive against a manifest that arrived from JSON without the field. The schema supplies a default,
  // but the registry must survive a malformed file rather than let one bad manifest break the menu for
  // every other generator.
  const presets = manifest.presets ?? [];
  if (presets.length === 0) {
    return [{ generator: manifest.id, label: manifestLabel(manifest), surfaces: manifest.surfaces ?? [] }];
  }
  return presets.map((preset) => ({
    generator: manifest.id,
    preset: preset.id,
    label: preset.name,
    surfaces: manifest.surfaces,
  }));
}

/**
 * Parameters visible in the panel for a preset.
 *
 * A *pinned* parameter is hidden, which is what makes a preset feel like its own tool rather than the
 * same form with different defaults. A parameter the preset merely *sets* stays visible: it is a
 * starting value, not a decision taken away from the user.
 */
export function visibleParams(manifest: GeneratorManifest, presetId?: PresetId): readonly GeneratorParam[] {
  if (presetId === undefined) return manifest.params;
  const preset = manifest.presets.find((candidate) => candidate.id === presetId);
  if (preset === undefined) return manifest.params;
  return manifest.params.filter((param) => !(param.key in preset.pin));
}

/**
 * Effective parameter values for a preset.
 *
 * Three layers, in the only order that makes sense: the manifest's own defaults, then what the preset
 * *sets* as a starting point, then what it *pins*. A pin last, because it is the one value that
 * cannot be argued with — and a preset that both set and pinned the same key would otherwise depend
 * on which was written first.
 */
export function effectiveDefaults(
  manifest: GeneratorManifest,
  presetId?: PresetId,
): Readonly<Record<string, string | number | boolean>> {
  const values: Record<string, string | number | boolean> = {};
  for (const param of manifest.params) {
    if (param.default !== undefined) values[param.key] = param.default;
  }
  const preset =
    presetId === undefined ? undefined : manifest.presets.find((candidate) => candidate.id === presetId);
  if (preset !== undefined) {
    if (preset.set !== undefined) Object.assign(values, preset.set);
    Object.assign(values, preset.pin);
  }
  return values;
}
