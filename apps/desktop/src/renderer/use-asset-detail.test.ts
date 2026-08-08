import { describe, expect, it } from 'vitest';
import { assetPath } from '@nos/core';
import { formatDuration, hasDerivation, isGeneratedAsset, summarize } from './use-asset-detail.js';
import { formatCacheSize } from './use-cache-stats.js';

/**
 * What the browser says about a file, and about the cache.
 *
 * The detection rule is the part worth pinning down. "Does a proxy exist" must be answered by
 * *looking*, and looking has to survive the fact that the spec in a cache filename varies — the
 * filmstrip's thumbnail rate follows the zoom level, so an exact-name check would report "no
 * filmstrip" for an asset that has three of them.
 */

const digest = '34d75a9f43a76770';
const entries = [
  `cache/proxy_1080p30q23_${digest}.mp4`,
  `cache/filmstrip_h66n0.5_${digest}.jpg`,
  `cache/filmstrip_h34n1_${digest}.jpg`,
  'cache/proxy_1080p30q23_ffffffffffffffff.mp4',
];

describe('finding a derivation', () => {
  it('finds a proxy for the asset', () => {
    expect(hasDerivation(entries, 'proxy', `${digest}0000`)).toBe(true);
  });

  it('finds a filmstrip whatever spec it was made at', () => {
    // The rate follows the zoom level, so the name cannot be predicted from a default.
    expect(hasDerivation(entries, 'filmstrip', `${digest}0000`)).toBe(true);
  });

  it('does not credit an asset with another asset´s proxy', () => {
    expect(hasDerivation(entries, 'proxy', '0123456789abcdef0000')).toBe(false);
  });

  it('does not confuse one kind for another', () => {
    expect(hasDerivation(entries, 'waveform', `${digest}0000`)).toBe(false);
  });

  it('says no when the cache is empty rather than guessing', () => {
    expect(hasDerivation([], 'proxy', `${digest}0000`)).toBe(false);
  });

  it('matches the truncated digest the sidecar names files with', () => {
    // The cache key carries 16 hex characters of a longer hash; comparing the whole thing would
    // never match anything.
    expect(hasDerivation(entries, 'proxy', digest)).toBe(true);
  });

  it('is not fooled by a hash that merely ends the same way', () => {
    const shifted = [`cache/proxy_1080p30q23_a${digest.slice(1)}.mp4`];
    expect(hasDerivation(shifted, 'proxy', digest)).toBe(false);
  });
});

describe('describing a file', () => {
  it('leads with the dimensions of a video and includes its length', () => {
    // "How long is this" is the question asked most of a file about to go on a timeline, and the one
    // thing its name never tells you.
    const text = summarize({
      type: 'video',
      hash: digest,
      duration_seconds: 83.4,
      video: { width: 3840, height: 2160, codec: 'h264' },
    });

    expect(text).toBe('3840×2160 · h264 · 1:23');
  });

  it('describes audio in the terms audio is judged by', () => {
    const text = summarize({
      type: 'audio',
      hash: digest,
      duration_seconds: 12,
      audio: { sample_rate: 48000, channels: 2, codec: 'flac' },
    });

    expect(text).toBe('48000 Hz · 2 ch · flac · 0:12');
  });

  it('names a single channel rather than counting it', () => {
    const text = summarize({
      type: 'audio',
      hash: digest,
      audio: { sample_rate: 48000, channels: 1, codec: 'flac' },
    });

    expect(text).toContain('mono');
  });

  it('omits a duration it does not have, rather than printing 0:00', () => {
    const text = summarize({
      type: 'video',
      hash: digest,
      duration_seconds: null,
      video: { width: 1920, height: 1080, codec: 'h264' },
    });

    expect(text).toBe('1920×1080 · h264');
  });

  it('falls back to the type for something with no streams', () => {
    expect(summarize({ type: 'text', hash: digest })).toBe('text');
  });
});

describe('duration', () => {
  it('reads as a timeline position, not as a number of seconds', () => {
    expect(formatDuration(83.4)).toBe('1:23');
    expect(formatDuration(3)).toBe('0:03');
  });

  it('does not show a negative duration for a broken probe', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('provenance', () => {
  it('treats the generated folder as generated, as everything else in this application does', () => {
    expect(isGeneratedAsset(assetPath('generated/t2v_0117.mp4'))).toBe(true);
    expect(isGeneratedAsset(assetPath('media/interview.mp4'))).toBe(false);
  });
});

describe('cache size', () => {
  it('uses the unit a file manager would', () => {
    // Decimal, matching every drive label and file manager on the machine. Being consistent with the
    // rest of the desktop matters more here than being consistent with memory sizes.
    expect(formatCacheSize(218_000_000)).toBe('218 MB');
  });

  it('keeps a digit where one is informative', () => {
    expect(formatCacheSize(2_400_000_000)).toBe('2.4 GB');
  });

  it('shows small caches in bytes rather than as 0.0 kB', () => {
    expect(formatCacheSize(512)).toBe('512 B');
  });

  it('shows an empty cache as nothing at all', () => {
    expect(formatCacheSize(0)).toBe('0 B');
  });
});
