import type { AssetPath, Result } from '@nos/core';
import { err, ok } from '@nos/core';
import type { AudioBufferProvider, AudioLoadError } from '@nos/audio';

/**
 * Decoded audio, cached.
 *
 * The engine deliberately does not own this: export streams once and never looks back, while preview
 * revisits the same few seconds hundreds of times, so the caching policy belongs to whoever knows which
 * of those is happening. This is the preview's policy.
 *
 * Three properties it exists to hold:
 *
 * - **One decode per asset, ever.** The scheduler asks for the same asset on every tick, twenty times a
 *   second. Without in-flight deduplication that is twenty concurrent decodes of the same file, each
 *   allocating its own copy.
 * - **A bounded footprint.** A stereo minute at 48 kHz is about 23 MB decoded; a handful of long clips
 *   will exhaust memory without a cap. Eviction is least-recently-used, because the playhead moves
 *   locally and the clip it just left is the one least likely to be needed next.
 * - **Failures are values.** A missing or undecodable file is a `Result`, not a throw: the engine has to
 *   keep playing the other tracks, and a rejected promise inside a scheduler tick takes the whole
 *   playback loop with it.
 */

/** Decoded bytes to keep resident. Roughly twenty minutes of stereo 48 kHz audio. */
export const DEFAULT_CACHE_BYTES = 512 * 1024 * 1024;

export interface AudioBufferCacheOptions {
  readonly context: BaseAudioContext;
  /** Resolves a project-relative asset to a fetchable URL. `undefined` when the sidecar is not up. */
  readonly urlFor: (asset: AssetPath) => string | undefined;
  readonly maxBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface AudioBufferCache extends AudioBufferProvider {
  /** Resident bytes, for the diagnostics panel. */
  readonly sizeBytes: number;
  clear(): void;
}

interface Entry {
  readonly buffer: AudioBuffer;
  readonly bytes: number;
  /** Monotonic counter rather than a clock: two loads in the same millisecond must still order. */
  usedAt: number;
}

export function createAudioBufferCache(options: AudioBufferCacheOptions): AudioBufferCache {
  const { context, urlFor } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_CACHE_BYTES;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<Result<AudioBuffer, AudioLoadError>>>();
  let clock = 0;
  let residentBytes = 0;

  function evictTo(limit: number): void {
    if (residentBytes <= limit) return;
    // Sorted per eviction rather than kept in order: eviction is rare and a sort of a few hundred
    // entries costs nothing next to a decode.
    const byAge = [...entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, entry] of byAge) {
      if (residentBytes <= limit) return;
      entries.delete(key);
      residentBytes -= entry.bytes;
    }
  }

  return {
    get sizeBytes() {
      return residentBytes;
    },

    peek(asset) {
      const entry = entries.get(asset);
      if (entry === undefined) return undefined;
      clock += 1;
      entry.usedAt = clock;
      return entry.buffer;
    },

    async load(asset) {
      const cached = entries.get(asset);
      if (cached !== undefined) {
        clock += 1;
        cached.usedAt = clock;
        return ok(cached.buffer);
      }

      const pending = inFlight.get(asset);
      if (pending !== undefined) return pending;

      const url = urlFor(asset);
      if (url === undefined) {
        return err({ kind: 'not-found', asset });
      }

      const work = (async (): Promise<Result<AudioBuffer, AudioLoadError>> => {
        try {
          const response = await doFetch(url);
          if (!response.ok) return err({ kind: 'not-found', asset });

          const bytes = await response.arrayBuffer();
          const buffer = await context.decodeAudioData(bytes);
          const size = buffer.length * buffer.numberOfChannels * 4;

          clock += 1;
          entries.set(asset, { buffer, bytes: size, usedAt: clock });
          residentBytes += size;
          evictTo(maxBytes);

          return ok(buffer);
        } catch (error) {
          return err({
            kind: 'decode-failed',
            asset,
            detail: error instanceof Error ? error.message : String(error),
          });
        } finally {
          inFlight.delete(asset);
        }
      })();

      inFlight.set(asset, work);
      return work;
    },

    prefetch(assets) {
      for (const asset of assets) {
        if (entries.has(asset) || inFlight.has(asset)) continue;
        // Fire and forget: a prefetch that fails is not an error, it is a cache miss later.
        void this.load(asset);
      }
    },

    clear() {
      entries.clear();
      residentBytes = 0;
    },
  };
}
