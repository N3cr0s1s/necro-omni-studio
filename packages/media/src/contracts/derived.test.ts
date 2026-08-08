import { describe, expect, it } from 'vitest';
import { contentHash } from '@nos/core';
import {
  DEFAULT_FILMSTRIP,
  DEFAULT_PROXY,
  DEFAULT_WAVEFORM,
  DERIVED_EXTENSIONS,
  cacheKey,
  derivedPath,
  describeSpec,
} from './derived.js';

const hashA = contentHash('9f3c1a27b4e8d0165af0e1c2d3b4a5f6');
const hashB = contentHash('0011223344556677889900aabbccddee');

describe('cacheKey', () => {
  it('is stable for the same content and spec', () => {
    expect(cacheKey(hashA, DEFAULT_PROXY)).toBe(cacheKey(hashA, DEFAULT_PROXY));
  });

  it('differs when the content differs, so replacing a file cannot reuse its proxy', () => {
    expect(cacheKey(hashA, DEFAULT_PROXY)).not.toBe(cacheKey(hashB, DEFAULT_PROXY));
  });

  it('differs when a derivation parameter differs', () => {
    // Otherwise a settings change would silently serve the old artifact, which presents as
    // "the preview is mysteriously soft" and is very hard to trace.
    expect(cacheKey(hashA, DEFAULT_PROXY)).not.toBe(cacheKey(hashA, { ...DEFAULT_PROXY, shortEdge: 720 }));
    expect(cacheKey(hashA, DEFAULT_PROXY)).not.toBe(cacheKey(hashA, { ...DEFAULT_PROXY, frameRate: 60 }));
    expect(cacheKey(hashA, DEFAULT_PROXY)).not.toBe(cacheKey(hashA, { ...DEFAULT_PROXY, quality: 18 }));
  });

  it('differs across kinds derived from identical bytes', () => {
    expect(cacheKey(hashA, DEFAULT_PROXY)).not.toBe(cacheKey(hashA, DEFAULT_FILMSTRIP));
  });

  it('is independent of the asset path, so a rename keeps the cache warm', () => {
    // The key takes only the hash: identity is the path, but cache identity is content.
    expect(cacheKey(hashA, DEFAULT_PROXY)).toContain('9f3c1a27b4e8d016');
  });

  it('stays readable and path-safe', () => {
    const key = cacheKey(hashA, DEFAULT_PROXY);
    expect(key).toBe('proxy_1080p30q23_9f3c1a27b4e8d016');
    expect(key).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('truncates the hash to a width that stays collision-free at project scale', () => {
    const key = cacheKey(hashA, DEFAULT_PROXY);
    expect(key.endsWith(hashA.slice(0, 16))).toBe(true);
    expect(key).not.toContain(hashA);
  });
});

describe('describeSpec', () => {
  it('encodes every parameter that affects the output', () => {
    expect(describeSpec(DEFAULT_PROXY)).toBe('1080p30q23');
    expect(describeSpec(DEFAULT_FILMSTRIP)).toBe('h34n1');
    expect(describeSpec(DEFAULT_WAVEFORM)).toBe('b100mono');
  });

  it('distinguishes per-channel waveforms from summed ones', () => {
    expect(describeSpec({ ...DEFAULT_WAVEFORM, perChannel: true })).toBe('b100multi');
  });
});

describe('derivedPath', () => {
  it('places artifacts under the disposable cache folder', () => {
    expect(derivedPath(hashA, DEFAULT_PROXY)).toBe('cache/proxy_1080p30q23_9f3c1a27b4e8d016.mp4');
  });

  it('uses the extension registered for the kind', () => {
    expect(derivedPath(hashA, DEFAULT_FILMSTRIP).endsWith(`.${DERIVED_EXTENSIONS.filmstrip}`)).toBe(true);
    expect(derivedPath(hashA, DEFAULT_WAVEFORM).endsWith(`.${DERIVED_EXTENSIONS.waveform}`)).toBe(true);
  });
});

describe('defaults', () => {
  it('matches the spec preview target of 1080p at 30', () => {
    expect(DEFAULT_PROXY.shortEdge).toBe(1080);
    expect(DEFAULT_PROXY.frameRate).toBe(30);
  });

  it('sizes filmstrip thumbnails for the clip body height in the mockups', () => {
    expect(DEFAULT_FILMSTRIP.thumbnailHeight).toBe(34);
  });
});
