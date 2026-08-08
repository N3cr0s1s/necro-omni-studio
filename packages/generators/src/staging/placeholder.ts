import { type FrameCount, type FrameRate, frameCount, frameRateToNumber } from '@nos/core';
import type { GeneratorManifest, GeneratorParam } from '../contracts/manifest.js';

/**
 * Placeholder sizing.
 *
 * The spec's table in §2.4: a `declared` manifest can be sized **before the job runs**, so the placeholder
 * occupies its real length on the timeline and the surrounding cut is already correct while the generator
 * works. A `discovered` manifest cannot, and gets the insertion rule that never shifts later clips.
 *
 * Which parameter carries the length is a manifest-level fact, so it is declared rather than inferred. The
 * key-convention fallback below exists only so the manifests printed in the spec — which predate this
 * field — size correctly without being rewritten.
 */

export type DurationUnit = 'seconds' | 'frames';

/** Explicit declaration of where a `declared` manifest's length comes from. */
export interface DurationSource {
  readonly param: string;
  readonly unit: DurationUnit;
}

/**
 * Parameter keys treated as a length when a manifest declares no `durationFrom`.
 *
 * A documented convention, not a guess about a particular generator: any manifest may override it with an
 * explicit declaration, and nothing here names a model, a graph or a generator id.
 */
export const DURATION_KEY_CONVENTION: readonly string[] = [
  'duration_s',
  'duration',
  'length_s',
  'length',
  'seconds',
];

/** Where this manifest's declared length comes from, or `undefined` if it has none. */
export function durationSource(manifest: GeneratorManifest): DurationSource | undefined {
  if (manifest.duration !== 'declared') return undefined;

  const declared = manifest.durationFrom;
  if (declared !== undefined) {
    // Trusted only if the parameter actually exists: a stale declaration would otherwise size every
    // placeholder from a missing value and produce silently wrong-length clips.
    return manifest.params.some((param) => param.key === declared.param) ? declared : undefined;
  }

  const byConvention = manifest.params.find(
    (param) => isNumeric(param) && DURATION_KEY_CONVENTION.includes(param.key),
  );
  return byConvention === undefined ? undefined : { param: byConvention.key, unit: 'seconds' };
}

function isNumeric(param: GeneratorParam): boolean {
  return param.type === 'int' || param.type === 'float';
}

export interface PlaceholderRequest {
  readonly manifest: GeneratorManifest;
  /** Effective values, presets already applied. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly frameRate: FrameRate;
  /** Length used when the manifest cannot declare one. */
  readonly fallback?: FrameCount;
}

/** Frames a `discovered` placeholder occupies until its real length is known: two seconds. */
export const DISCOVERED_PLACEHOLDER_SECONDS = 2;

export interface PlaceholderLength {
  readonly frames: FrameCount;
  /** False when the length is a stand-in, so the UI can mark it as provisional. */
  readonly known: boolean;
}

/**
 * How long a placeholder should be.
 *
 * Always returns a length. A zero-width placeholder would be unselectable and undroppable, so an unknown
 * length becomes a short visible stand-in that is explicitly flagged as provisional — the clip is replaced
 * with its real length when the output lands.
 */
export function placeholderLength(request: PlaceholderRequest): PlaceholderLength {
  const { manifest, params, frameRate } = request;
  const fps = frameRateToNumber(frameRate);
  const source = durationSource(manifest);

  if (source !== undefined) {
    const raw = params[source.param];
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value) && value > 0) {
      const frames = source.unit === 'frames' ? value : value * fps;
      // Rounded up: a placeholder shorter than the output would let a neighbour sit where the real clip
      // needs to be, and the correction would then have to move someone else's edit.
      return { frames: frameCount(Math.max(1, Math.ceil(frames))), known: true };
    }
  }

  const fallback = request.fallback ?? frameCount(Math.max(1, Math.round(DISCOVERED_PLACEHOLDER_SECONDS * fps)));
  return { frames: fallback, known: false };
}
