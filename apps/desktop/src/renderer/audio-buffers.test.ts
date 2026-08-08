import { describe, expect, it, vi } from 'vitest';
import { assetPath } from '@nos/core';
import { DEFAULT_CACHE_BYTES, createAudioBufferCache } from './audio-buffers.js';

/**
 * A stand-in for a decoded buffer.
 *
 * The cache never inspects samples — it needs a length, a channel count and identity — so a fake keeps
 * the test about caching policy rather than about Web Audio.
 */
function fakeBuffer(seconds: number, channels = 2, sampleRate = 48_000): AudioBuffer {
  return { length: Math.round(seconds * sampleRate), numberOfChannels: channels } as AudioBuffer;
}

interface Harness {
  readonly cache: ReturnType<typeof createAudioBufferCache>;
  readonly decodes: string[];
  readonly fetches: string[];
}

function harness(options: { maxBytes?: number; fail?: 'fetch' | 'decode'; seconds?: number } = {}): Harness {
  const decodes: string[] = [];
  const fetches: string[] = [];
  let pending: string | undefined;

  const context = {
    async decodeAudioData(): Promise<AudioBuffer> {
      decodes.push(pending ?? '');
      if (options.fail === 'decode') throw new Error('unsupported codec');
      return fakeBuffer(options.seconds ?? 1);
    },
  } as unknown as BaseAudioContext;

  const cache = createAudioBufferCache({
    context,
    urlFor: (asset) => (asset === 'media/missing.wav' ? undefined : `http://sidecar/${asset}`),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetches.push(url);
      pending = url;
      if (options.fail === 'fetch') return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    }) as typeof globalThis.fetch,
  });

  return { cache, decodes, fetches };
}

const asset = (name: string) => assetPath(`media/${name}`);

describe('loading', () => {
  it('decodes once and serves the cache afterwards', async () => {
    const { cache, decodes } = harness();

    const first = await cache.load(asset('a.wav'));
    const second = await cache.load(asset('a.wav'));

    expect(first.ok && second.ok).toBe(true);
    expect(decodes).toHaveLength(1);
  });

  it('deduplicates concurrent loads of the same asset', async () => {
    // The scheduler asks for the same asset on every tick, twenty times a second. Without this that is
    // twenty concurrent decodes of one file, each allocating its own copy.
    const { cache, decodes } = harness();

    await Promise.all([cache.load(asset('a.wav')), cache.load(asset('a.wav')), cache.load(asset('a.wav'))]);

    expect(decodes).toHaveLength(1);
  });

  it('does not deduplicate different assets', async () => {
    const { cache, decodes } = harness();
    await Promise.all([cache.load(asset('a.wav')), cache.load(asset('b.wav'))]);
    expect(decodes).toHaveLength(2);
  });

  it('retries after a failure rather than caching it', async () => {
    // A failed decode is usually a file still being written by a generator. Caching the failure would
    // make the clip permanently silent until the application restarts.
    const failing = harness({ fail: 'fetch' });
    await failing.cache.load(asset('a.wav'));
    await failing.cache.load(asset('a.wav'));
    expect(failing.fetches).toHaveLength(2);
  });
});

describe('failures are values', () => {
  it('reports a missing file rather than throwing', async () => {
    // A rejected promise inside a scheduler tick takes the whole playback loop with it, silencing every
    // other track.
    const { cache } = harness({ fail: 'fetch' });
    const result = await cache.load(asset('a.wav'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-found');
  });

  it('reports a decode failure with the reason', async () => {
    const { cache } = harness({ fail: 'decode' });
    const result = await cache.load(asset('a.wav'));

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'decode-failed') {
      expect(result.error.detail).toContain('unsupported codec');
    } else {
      throw new Error('expected a decode failure');
    }
  });

  it('reports an asset it cannot even address', async () => {
    // No sidecar means no URL. That is a different situation from a file that is genuinely absent, but
    // the engine responds to both the same way — by not scheduling the clip.
    const { cache, fetches } = harness();
    const result = await cache.load(assetPath('media/missing.wav'));

    expect(result.ok).toBe(false);
    expect(fetches).toHaveLength(0);
  });
});

describe('peeking', () => {
  it('returns nothing without starting work', async () => {
    const { cache, fetches } = harness();
    expect(cache.peek(asset('a.wav'))).toBeUndefined();
    expect(fetches).toHaveLength(0);
  });

  it('returns a resident buffer', async () => {
    const { cache } = harness();
    await cache.load(asset('a.wav'));
    expect(cache.peek(asset('a.wav'))).toBeDefined();
  });
});

describe('eviction', () => {
  it('keeps the footprint under the cap', async () => {
    // A stereo minute at 48 kHz is about 23 MB decoded; a handful of long clips exhausts memory without
    // a bound.
    const oneSecondBytes = 48_000 * 2 * 4;
    const { cache } = harness({ maxBytes: oneSecondBytes * 2, seconds: 1 });

    for (const name of ['a.wav', 'b.wav', 'c.wav', 'd.wav']) await cache.load(asset(name));

    expect(cache.sizeBytes).toBeLessThanOrEqual(oneSecondBytes * 2);
  });

  it('evicts the least recently used, not the oldest', async () => {
    // The playhead moves locally, so the clip it just left is the one least likely to be needed next —
    // and the one loaded first is often the one being looped.
    const oneSecondBytes = 48_000 * 2 * 4;
    const { cache } = harness({ maxBytes: oneSecondBytes * 2, seconds: 1 });

    await cache.load(asset('a.wav'));
    await cache.load(asset('b.wav'));
    cache.peek(asset('a.wav'));
    await cache.load(asset('c.wav'));

    expect(cache.peek(asset('a.wav'))).toBeDefined();
    expect(cache.peek(asset('b.wav'))).toBeUndefined();
  });

  it('reports its size', async () => {
    const { cache } = harness({ seconds: 1 });
    expect(cache.sizeBytes).toBe(0);
    await cache.load(asset('a.wav'));
    expect(cache.sizeBytes).toBe(48_000 * 2 * 4);
  });

  it('clears everything', async () => {
    const { cache } = harness();
    await cache.load(asset('a.wav'));
    cache.clear();

    expect(cache.sizeBytes).toBe(0);
    expect(cache.peek(asset('a.wav'))).toBeUndefined();
  });

  it('defaults to a bound large enough to be useful', () => {
    // Twenty minutes of stereo 48 kHz. Small enough not to be the reason a machine swaps, large enough
    // that ordinary editing never evicts.
    expect(DEFAULT_CACHE_BYTES).toBeGreaterThanOrEqual(256 * 1024 * 1024);
  });
});

describe('prefetching', () => {
  it('loads assets that are not resident', async () => {
    const { cache, fetches } = harness();
    cache.prefetch([asset('a.wav'), asset('b.wav')]);
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
  });

  it('skips what is already loaded or in flight', async () => {
    const { cache, fetches } = harness();
    await cache.load(asset('a.wav'));
    cache.prefetch([asset('a.wav')]);

    await vi.waitFor(() => expect(fetches).toHaveLength(1));
  });
});
