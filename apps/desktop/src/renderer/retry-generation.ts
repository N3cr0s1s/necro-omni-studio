import type { GeneratorId, JobGroupId } from '@nos/core';
import type { EnqueueRequest, GeneratorManifest, QueueSnapshot } from '@nos/generators';

/**
 * Rebuilding the request behind a finished group, so it can be run again.
 *
 * Separated from the shell because it is the part with decisions in it. The callback in `App` is then
 * a lookup and a call, which is the shape this project keeps arriving at: the judgement lives where it
 * can be checked without rendering, and the wiring is short enough to read in one line.
 *
 * The queue keeps a **generator id**, not a manifest — so repeating a request means resolving one
 * through the registry, and that is the whole reason this cannot live on the runtime. A generator
 * removed from the library since the run has no manifest and therefore no retry; the caller offers no
 * button rather than one that would refuse.
 */

/**
 * The one thing a retry needs from the registry: an id back to the manifest it names.
 *
 * Narrowed to the single method rather than taking `GeneratorRegistry`, because that is what this
 * depends on — and a function that asks for the whole registry cannot be exercised without building
 * one, which means validating manifests against a backend to test a lookup. `GeneratorRegistry`
 * satisfies this structurally, so the shell passes its own with no adapter.
 */
export interface ManifestSource {
  manifestFor(id: GeneratorId): GeneratorManifest | undefined;
}

export interface RetryLookup {
  readonly snapshot: QueueSnapshot;
  /** Absent before the library has loaded, which is a real state and not an error. */
  readonly registry: ManifestSource | undefined;
}

/**
 * The request that would repeat a group, or `undefined` when it cannot be repeated.
 *
 * Repeated **as it was asked for**: same parameters, same target, same variant count. Seeds are left
 * to be derived afresh, which is deliberate — a failed run produced nothing, so there is no image to
 * reproduce, and the user is asking for the request again rather than for a particular result.
 *
 * Preserving the seed would have meant `lockedSeed`, and §5.8 forces a locked seed to a single
 * variant: a three-variant request would come back as a one-variant one, quietly, on the way through
 * a retry that was supposed to change nothing.
 */
export function retryRequest(lookup: RetryLookup, id: JobGroupId): EnqueueRequest | undefined {
  const group = lookup.snapshot.groups.find((candidate) => candidate.id === id);
  if (group === undefined) return undefined;

  const manifest = lookup.registry?.manifestFor(group.generator);
  if (manifest === undefined) return undefined;

  return {
    manifest,
    // Spread rather than assigned, because `exactOptionalPropertyTypes` makes an explicit `undefined`
    // a different thing from an absent key — and the queue reads `preset` with `in`.
    ...(group.preset === undefined ? {} : { preset: group.preset }),
    params: group.params,
    target: group.target,
    variantCount: group.variantCount,
  };
}
