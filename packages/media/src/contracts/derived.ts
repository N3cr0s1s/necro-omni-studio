import type { AssetPath, ContentHash, Result } from '@nos/core';

/**
 * Derived artifacts: proxies, filmstrips and waveform peaks.
 *
 * All three are expensive to produce, cheap to reproduce, and live under `cache/` — the one
 * project folder the spec marks disposable. Nothing in a derived artifact is authored, so
 * deleting the whole cache must only cost time.
 *
 * ## Cache identity
 *
 * The spec fixes asset *identity* as the project-relative path and the cache *key* as the
 * content hash. Content hashing is what makes the cache correct across the things users
 * actually do: renaming a file must not discard its proxy, and replacing a file with
 * different content at the same path must not silently reuse the old one.
 *
 * The key also folds in the derivation parameters. A proxy rendered at 720p and one at 1080p
 * are different artifacts from identical bytes, so a key built from the hash alone would
 * serve the wrong file after a settings change — a class of bug that presents as "the
 * preview is mysteriously soft" and is very hard to trace back.
 */

/** Proxy resolution and rate. The spec's preview target is realtime 1080p/30. */
export interface ProxySpec {
  readonly kind: 'proxy';
  /**
   * The `p` number, as in `1080p` — the **short** edge in pixels.
   *
   * Height for landscape material, width for portrait. This is the broadcast convention the
   * spec's "1080p" refers to, and it is deliberately *not* a cap on the long edge: a 9:16
   * clip at 1080p is 1080×1920, not 608×1080. Naming this `maxEdge` would be a lie that
   * only shows up on vertical footage.
   */
  readonly shortEdge: number;
  readonly frameRate: number;
  /** Constant-rate-factor style quality knob; lower is better. */
  readonly quality: number;
}

/** A horizontal strip of thumbnails drawn inside a video clip body. */
export interface FilmstripSpec {
  readonly kind: 'filmstrip';
  readonly thumbnailHeight: number;
  /** Thumbnails sampled per second of source. */
  readonly thumbnailsPerSecond: number;
}

/** Min/max peak pairs per bucket, for drawing an audio clip. */
export interface WaveformSpec {
  readonly kind: 'waveform';
  /** Buckets per second. Higher resolves transients at the cost of file size. */
  readonly bucketsPerSecond: number;
  /** Channels are summed to mono when false, keeping the peak file half the size. */
  readonly perChannel: boolean;
}

export type DerivedSpec = ProxySpec | FilmstripSpec | WaveformSpec;

export type DerivedKind = DerivedSpec['kind'];

/**
 * Defaults matching the spec's stated targets.
 *
 * Exported rather than inlined so the settings UI and the cache-key function cannot drift
 * apart, and so a test can assert what a default-configured project produces.
 */
export const DEFAULT_PROXY: ProxySpec = {
  kind: 'proxy',
  shortEdge: 1080,
  frameRate: 30,
  quality: 23,
};

export const DEFAULT_FILMSTRIP: FilmstripSpec = {
  kind: 'filmstrip',
  thumbnailHeight: 34,
  thumbnailsPerSecond: 1,
};

export const DEFAULT_WAVEFORM: WaveformSpec = {
  kind: 'waveform',
  bucketsPerSecond: 100,
  perChannel: false,
};

/**
 * A cache key: `<kind>_<params>_<hash>`.
 *
 * Deliberately a readable composite rather than a hash of a hash. A cache directory a human
 * can read is worth a few extra characters — when a proxy looks wrong, the answer is
 * visible in the filename instead of requiring a debugger. Every component is path-safe.
 */
export type CacheKey = string;

export function describeSpec(spec: DerivedSpec): string {
  switch (spec.kind) {
    case 'proxy':
      return `${spec.shortEdge}p${spec.frameRate}q${spec.quality}`;
    case 'filmstrip':
      return `h${spec.thumbnailHeight}n${spec.thumbnailsPerSecond}`;
    case 'waveform':
      return `b${spec.bucketsPerSecond}${spec.perChannel ? 'multi' : 'mono'}`;
    default: {
      const unreachable: never = spec;
      throw new Error(`Unhandled derived spec ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Builds the cache key for a derivation of specific content.
 *
 * The hash is truncated to 16 hex characters. At that width a collision needs ~2^32
 * distinct assets in one project before becoming likely, which is many orders of magnitude
 * beyond the spec's "200 clips, 20 minutes" target, and it keeps filenames readable.
 */
export function cacheKey(hash: ContentHash, spec: DerivedSpec): CacheKey {
  return `${spec.kind}_${describeSpec(spec)}_${hash.slice(0, 16)}`;
}

/** Extension each derived kind is stored with. */
export const DERIVED_EXTENSIONS: Readonly<Record<DerivedKind, string>> = {
  proxy: 'mp4',
  filmstrip: 'jpg',
  waveform: 'peaks',
};

/**
 * Location of a derived artifact, always under `cache/`.
 *
 * Returned as a plain string rather than an `AssetPath` because derived files are not
 * assets: they are never referenced by the document, and `referencedAssets` must not report
 * them or a project archive would carry regenerable data.
 */
export function derivedPath(hash: ContentHash, spec: DerivedSpec): string {
  return `cache/${cacheKey(hash, spec)}.${DERIVED_EXTENSIONS[spec.kind]}`;
}

export type DerivationError =
  | { readonly kind: 'source-missing'; readonly asset: AssetPath }
  | { readonly kind: 'failed'; readonly asset: AssetPath; readonly detail: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'sidecar-unavailable'; readonly detail: string };

/** Progress for the long-running derivations, so import does not look frozen. */
export interface DerivationProgress {
  readonly asset: AssetPath;
  readonly spec: DerivedSpec;
  /** `[0, 1]`, or `undefined` when the backend cannot estimate. */
  readonly fraction?: number;
}

export interface DerivedArtifact {
  readonly spec: DerivedSpec;
  readonly key: CacheKey;
  /** Path under `cache/`, relative to the project folder. */
  readonly path: string;
}

/** Peak data for drawing a waveform, as the renderer wants it. */
export interface WaveformPeaks {
  readonly bucketsPerSecond: number;
  readonly channels: number;
  /**
   * Interleaved min/max pairs in `[-1, 1]`, channel-major.
   *
   * A flat typed array rather than nested objects: an audio clip on screen can span tens of
   * thousands of buckets, and the renderer walks this once per frame.
   */
  readonly peaks: Float32Array;
}

/**
 * Produces and caches derived artifacts.
 *
 * `ensure` is idempotent and must be safe to call concurrently for the same input — the
 * media browser and the timeline will both ask for the same filmstrip on load. Implementations
 * are expected to coalesce in-flight work rather than render twice.
 */
export interface DerivedArtifactService {
  ensure(
    asset: AssetPath,
    spec: DerivedSpec,
    options?: DerivationOptions,
  ): Promise<Result<DerivedArtifact, DerivationError>>;

  /** Cached artifact if present, without starting work. Drives optimistic rendering. */
  peek(asset: AssetPath, spec: DerivedSpec): Promise<DerivedArtifact | undefined>;

  readWaveform(asset: AssetPath, spec: WaveformSpec): Promise<Result<WaveformPeaks, DerivationError>>;

  /** Total bytes under `cache/`, for the browser's folder-size readout. */
  cacheSize(): Promise<number>;

  /** Discards the whole cache. Safe by construction: everything here is regenerable. */
  clearCache(): Promise<Result<void, DerivationError>>;
}

export interface DerivationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DerivationProgress) => void;
}
