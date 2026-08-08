import type { GeneratorManifest } from '../contracts/manifest.js';
import { seedParam, supportsBatch, supportsVariants } from '../contracts/manifest.js';

/**
 * Variant planning.
 *
 * The spec's rules, in one pure function so they cannot be applied inconsistently:
 *
 * - Variants are produced by varying the **seed**. A manifest without a seed parameter, or a run whose
 *   seed the user has locked, is forced to one variant — and the reason is carried, because the spec is
 *   explicit that the UI must explain it rather than silently return identical results.
 * - Execution is **sequential by default**. Batched is faster (the model loads once) but scales VRAM with
 *   the batch size and needs graph support, so it is opt-in via a `batch` block.
 * - Above `batch.max` the runner splits into several batched runs rather than failing or falling back
 *   entirely — six variants with a max of three is two runs, not one error and not six.
 */

export type VariantMode = 'sequential' | 'batched';

/** Why a requested variant count was reduced. */
export type VariantConstraint =
  | { readonly kind: 'no-seed-parameter' }
  | { readonly kind: 'seed-locked' }
  | { readonly kind: 'above-maximum'; readonly maximum: number };

export interface VariantBatch {
  /** Seeds this submit will produce, in order. */
  readonly seeds: readonly number[];
  readonly mode: VariantMode;
}

export interface VariantPlan {
  readonly mode: VariantMode;
  /** One entry per submit. Sequential mode yields one seed per batch. */
  readonly batches: readonly VariantBatch[];
  readonly totalVariants: number;
  /**
   * Why the count differs from what was requested, if it does.
   *
   * Surfaced so the panel can say "1 variant — this generator has no seed parameter" instead of quietly
   * disagreeing with the user.
   */
  readonly constraint?: VariantConstraint;
}

export interface VariantRequest {
  readonly manifest: GeneratorManifest;
  /** How many the user asked for. Defaults to the manifest's own default. */
  readonly requested?: number;
  /** A locked seed, when the user has pinned one. */
  readonly lockedSeed?: number;
  /** Supplies seeds. Injected so a plan is reproducible in a test. */
  readonly nextSeed: () => number;
  /** Hard cap regardless of manifest, from application settings. */
  readonly globalMaximum?: number;
}

/** Upper bound on variants per request, whatever a manifest says. */
export const MAX_VARIANTS = 16;

export function planVariants(request: VariantRequest): VariantPlan {
  const { manifest, lockedSeed, nextSeed } = request;
  const globalMaximum = Math.max(1, request.globalMaximum ?? MAX_VARIANTS);
  const requested = Math.max(1, Math.round(request.requested ?? manifest.defaultVariants));

  // A manifest with no seed parameter cannot vary anything, so N runs would return N identical results.
  if (!supportsVariants(manifest)) {
    return single(nextSeed, lockedSeed, { kind: 'no-seed-parameter' }, requested);
  }

  // A locked seed is the user pinning a specific result; producing variants would ignore that.
  if (lockedSeed !== undefined) {
    return single(nextSeed, lockedSeed, { kind: 'seed-locked' }, requested);
  }

  const capped = Math.min(requested, globalMaximum);
  const constraint: VariantConstraint | undefined =
    capped < requested ? { kind: 'above-maximum', maximum: globalMaximum } : undefined;

  const seeds = Array.from({ length: capped }, () => nextSeed());

  if (!supportsBatch(manifest)) {
    // Sequential works on every graph and each run can be cancelled independently, which is why it is the
    // default rather than a fallback.
    return {
      mode: 'sequential',
      batches: seeds.map((seed) => ({ seeds: [seed], mode: 'sequential' as const })),
      totalVariants: seeds.length,
      ...(constraint !== undefined ? { constraint } : {}),
    };
  }

  const batchMax = Math.max(1, manifest.batch?.max ?? 1);
  const batches: VariantBatch[] = [];
  for (let index = 0; index < seeds.length; index += batchMax) {
    batches.push({ seeds: seeds.slice(index, index + batchMax), mode: 'batched' });
  }

  return {
    mode: 'batched',
    batches,
    totalVariants: seeds.length,
    ...(constraint !== undefined ? { constraint } : {}),
  };
}

function single(
  nextSeed: () => number,
  lockedSeed: number | undefined,
  constraint: VariantConstraint,
  requested: number,
): VariantPlan {
  const seed = lockedSeed ?? nextSeed();
  return {
    mode: 'sequential',
    batches: [{ seeds: [seed], mode: 'sequential' }],
    totalVariants: 1,
    // Only reported when it actually reduced something: explaining a constraint the user did not hit is
    // noise, and noise trains people to ignore explanations.
    ...(requested > 1 ? { constraint } : {}),
  };
}

/** Human-readable reason, for the panel's variant control. */
export function describeConstraint(constraint: VariantConstraint): string {
  switch (constraint.kind) {
    case 'no-seed-parameter':
      return 'this generator has no seed parameter, so every run would be identical';
    case 'seed-locked':
      return 'the seed is locked, so every run would be identical';
    case 'above-maximum':
      return `limited to ${constraint.maximum} variants per run`;
    default: {
      const unreachable: never = constraint;
      throw new Error(`Unhandled constraint ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * A seed source.
 *
 * Injected everywhere rather than called directly, so a job's seeds are reproducible in a test and so a
 * future "reproduce this run" feature has a seam to replay through.
 */
export function createSeedSource(random: () => number = Math.random): () => number {
  return () => {
    // 32-bit unsigned: the range every backend accepts, and small enough to display in a clip label.
    return Math.floor(random() * 0xffffffff);
  };
}

/** A deterministic seed source, for tests and for replaying a recorded run. */
export function createFixedSeedSource(seeds: readonly number[]): () => number {
  let index = 0;
  return () => {
    const seed = seeds[index % seeds.length] ?? 0;
    index += 1;
    return seed;
  };
}
