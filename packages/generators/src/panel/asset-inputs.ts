import type { AssetPath, AssetType } from '@nos/core';
import type { GeneratorManifest, GeneratorParam, GeneratorParamType } from '../contracts/manifest.js';

/**
 * Asset-valued generator parameters, and what may be offered for one.
 *
 * A manifest can declare that a parameter *is* a file — `first_frame` for image-to-video, a voice
 * reference for a clone, a mask for an inpaint. Those parameters were rendered as a read-only field
 * reading `not set`, which made every image-to-anything generator unusable: the panel showed the
 * input it needed and gave no way to supply it, and `Generate` stayed lit and submitted a graph with
 * an empty image slot.
 *
 * The rule kept here, rather than in the panel, is the one that has to stay honest as generators are
 * added: **the choices are filtered by the parameter's declared type, never by the generator**. A
 * manifest asking for an image is offered images; one asking for audio is offered audio. Nothing in
 * this file knows which generator it is serving, and nothing may learn.
 *
 * The list of candidates comes from the caller — this package cannot read a folder, and should not.
 */

/** The asset parameter types, as the subset of parameter types that name a file. */
const ASSET_PARAM_TYPES = new Set<GeneratorParamType>(['image', 'video', 'audio', 'mask']);

export function isAssetParam(param: GeneratorParam): boolean {
  return ASSET_PARAM_TYPES.has(param.type);
}

/**
 * One offerable file.
 *
 * `label` is what the user reads and is the caller's business — a bare filename in a flat list, or a
 * folder-qualified one when two folders hold `frame.png`. Deciding that here would mean guessing at a
 * project layout this package deliberately knows nothing about.
 */
export interface AssetChoice {
  readonly path: AssetPath;
  readonly label: string;
  readonly type: AssetType;
}

/** Every asset-valued parameter of a manifest, in declaration order. */
export function assetParams(manifest: GeneratorManifest): readonly GeneratorParam[] {
  return manifest.params.filter(isAssetParam);
}

/**
 * The files offerable for one parameter.
 *
 * A mask parameter accepts an image as well as a mask: a mask *is* an image, the project keeps them
 * apart by folder rather than by format, and a user who painted one elsewhere would otherwise be told
 * there is nothing to choose while looking straight at the file.
 */
export function choicesFor(param: GeneratorParam, available: readonly AssetChoice[]): readonly AssetChoice[] {
  if (!isAssetParam(param)) return [];
  const accepted: ReadonlySet<AssetType> =
    param.type === 'mask'
      ? new Set<AssetType>(['mask', 'image'])
      : new Set<AssetType>([param.type as AssetType]);

  return available.filter((choice) => accepted.has(choice.type));
}

/**
 * Why a run cannot start yet.
 *
 * A value rather than a boolean, because the spec's standing rule for a disabled control is that it
 * must say what would enable it. `param` is present when a specific field is at fault, so the panel
 * can mark that field rather than only the button.
 */
export interface RunBlocker {
  readonly kind: 'unavailable' | 'unbound' | 'missing-input';
  readonly param?: string;
  readonly message: string;
}

export interface RunReadinessInput {
  readonly manifest: GeneratorManifest;
  readonly status: 'available' | 'unavailable' | 'unbound';
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Everything standing between the user and a run, worst first.
 *
 * All blockers are reported, not just the first: a panel that reveals one missing input per attempt
 * turns setting up a generator into a guessing game.
 */
export function runBlockers(input: RunReadinessInput): readonly RunBlocker[] {
  const blockers: RunBlocker[] = [];

  if (input.status === 'unavailable') {
    blockers.push({ kind: 'unavailable', message: 'the backend is missing nodes this graph needs' });
  } else if (input.status === 'unbound') {
    blockers.push({ kind: 'unbound', message: 'this manifest has no graph connected yet' });
  }

  for (const param of input.manifest.params) {
    if (param.required !== true) continue;
    const value = input.values[param.key];
    // Empty string counts as unset: a select's placeholder option and a cleared text field both land
    // here, and treating `''` as an answer would submit a graph with an empty input.
    if (value !== undefined && value !== '') continue;
    blockers.push({
      kind: 'missing-input',
      param: param.key,
      message: `${param.label ?? param.key} is required`,
    });
  }

  return blockers;
}

/** One line for the run button's title, or `undefined` when nothing is in the way. */
export function describeBlockers(blockers: readonly RunBlocker[]): string | undefined {
  if (blockers.length === 0) return undefined;
  const [first, ...rest] = blockers;
  if (first === undefined) return undefined;
  return rest.length === 0 ? first.message : `${first.message}, and ${rest.length} more`;
}
