import { describe, expect, it } from 'vitest';
import { type AssetPath, assetPath, clipId, frameIndex, spanFromBounds } from '@nos/core';
import type { MaskFrame, MaskPrompt, MaskTrack } from '../contracts/mask.js';
import { emptyTrack, maskTrackId, withPrompt } from '../contracts/mask.js';
import {
  type MaskStorage,
  createMaskCache,
  maskCacheKey,
  maskFramePath,
  parseFrame,
  serializeFrame,
} from './mask-cache.js';

const source = assetPath('media/shot.mp4');
const range = spanFromBounds(frameIndex(0), frameIndex(100));
const base = (): MaskTrack => emptyTrack(maskTrackId('m1'), clipId('c1'), range);

const point = (frame: number, x = 0.5, include = true): MaskPrompt => ({
  kind: 'point',
  frame: frameIndex(frame),
  x,
  y: 0.5,
  include,
});

const frame = (index: number, counts: readonly number[] = [0, 8]): MaskFrame => ({
  frame: frameIndex(index),
  width: 4,
  height: 2,
  counts,
});

/** In-memory storage, so the cache logic is testable without a filesystem. */
function memoryStorage(): MaskStorage & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) {
      return files.get(path);
    },
    async write(path, text) {
      files.set(path, text);
    },
    async list(folder) {
      return [...files.keys()].filter((path) => path.startsWith(`${folder}/`)) as AssetPath[];
    },
    async remove(folder) {
      for (const path of [...files.keys()]) if (path.startsWith(`${folder}/`)) files.delete(path);
    },
  };
}

describe('the cache key', () => {
  const key = (track: MaskTrack) =>
    maskCacheKey(source, { start: 0, end: 100 }, track.prompts);

  it('is stable for the same track', () => {
    const track = withPrompt(base(), point(10));
    expect(key(track)).toBe(key(track));
  });

  it('changes when a prompt moves', () => {
    // A cache that hit here would show a mask of whatever the user clicked *before*.
    expect(key(withPrompt(base(), point(10, 0.5)))).not.toBe(key(withPrompt(base(), point(10, 0.6))));
  });

  it('changes when a prompt flips from include to exclude', () => {
    expect(key(withPrompt(base(), point(10, 0.5, true)))).not.toBe(
      key(withPrompt(base(), point(10, 0.5, false))),
    );
  });

  it('changes with the source', () => {
    const track = withPrompt(base(), point(10));
    expect(maskCacheKey(source, { start: 0, end: 100 }, track.prompts)).not.toBe(
      maskCacheKey(assetPath('media/other.mp4'), { start: 0, end: 100 }, track.prompts),
    );
  });

  it('changes with the range', () => {
    const track = withPrompt(base(), point(10));
    expect(maskCacheKey(source, { start: 0, end: 100 }, track.prompts)).not.toBe(
      maskCacheKey(source, { start: 0, end: 50 }, track.prompts),
    );
  });

  it('distinguishes prompt order, since a refining click depends on what preceded it', () => {
    // Sorting for a "stable" key would make two genuinely different results share one.
    const forward = withPrompt(withPrompt(base(), point(10)), point(20));
    const reverse = withPrompt(withPrompt(base(), point(20)), point(10));
    expect(key(forward)).not.toBe(key(reverse));
  });

  it('survives float noise a click cannot express', () => {
    const a = withPrompt(base(), point(10, 0.5));
    const b = withPrompt(base(), point(10, 0.50000001));
    expect(key(a)).toBe(key(b));
  });
});

describe('the file form', () => {
  it('round trips', () => {
    const original = frame(7, [0, 3, 5]);
    expect(parseFrame(7, serializeFrame(original))).toEqual(original);
  });

  it('starts with the dimensions, so a file is readable in a terminal', () => {
    expect(serializeFrame(frame(7))).toBe('4 2\n0,8\n');
  });

  it('rejects a truncated file rather than decoding a torn mask', () => {
    // The crash-mid-write case. Decoding it would produce a mask with a diagonal tear.
    expect(() => parseFrame(7, '4 2\n0,3\n')).toThrow(SyntaxError);
  });

  it('rejects a file with no header', () => {
    expect(() => parseFrame(7, '0,8\n')).toThrow(SyntaxError);
  });

  it('pads the frame number so a listing sorts in frame order', () => {
    expect(maskFramePath(assetPath('masks/c1/m1'), 7)).toBe('masks/c1/m1/000007.rle');
  });
});

describe('reading and writing', () => {
  const trackWithPrompt = () => withPrompt(base(), point(10));

  it('saves and loads a run of frames', async () => {
    const cache = createMaskCache(memoryStorage());
    const track = trackWithPrompt();

    await cache.save(track, source, [frame(0), frame(1), frame(2)]);
    const loaded = await cache.load(track, source);
    expect(loaded.map((entry) => entry.frame)).toEqual([0, 1, 2]);
  });

  it('returns frames in order regardless of how storage lists them', async () => {
    const storage = memoryStorage();
    const cache = createMaskCache(storage);
    const track = trackWithPrompt();

    await cache.save(track, source, [frame(2), frame(0), frame(1)]);
    expect((await cache.load(track, source)).map((entry) => entry.frame)).toEqual([0, 1, 2]);
  });

  it('misses after a prompt changes', async () => {
    // The property that makes the cache safe: a changed track cannot read the previous track's masks.
    const cache = createMaskCache(memoryStorage());
    const track = trackWithPrompt();
    await cache.save(track, source, [frame(0)]);

    expect(await cache.load(withPrompt(track, point(20)), source)).toEqual([]);
  });

  it('skips a corrupt frame instead of failing the whole load', async () => {
    // Refusing to show 400 good frames because one is torn would be the wrong trade.
    const storage = memoryStorage();
    const cache = createMaskCache(storage);
    const track = trackWithPrompt();

    await cache.save(track, source, [frame(0), frame(1)]);
    const folder = cache.folderFor(track, source);
    await storage.write(maskFramePath(folder, 1), '4 2\n0,3\n');

    expect((await cache.load(track, source)).map((entry) => entry.frame)).toEqual([0]);
  });

  it('ignores files that are not masks', async () => {
    const storage = memoryStorage();
    const cache = createMaskCache(storage);
    const track = trackWithPrompt();

    await cache.save(track, source, [frame(0)]);
    await storage.write(assetPath(`${cache.folderFor(track, source)}/notes.txt`), 'hello');

    expect(await cache.load(track, source)).toHaveLength(1);
  });

  it('evicts only its own track', async () => {
    const storage = memoryStorage();
    const cache = createMaskCache(storage);
    const kept = trackWithPrompt();
    const other = withPrompt(emptyTrack(maskTrackId('m2'), clipId('c1'), range), point(10));

    await cache.save(kept, source, [frame(0)]);
    await cache.save(other, source, [frame(0)]);
    await cache.evict(other, source);

    expect(await cache.load(kept, source)).toHaveLength(1);
    expect(await cache.load(other, source)).toHaveLength(0);
  });

  it('keeps masks under the project´s masks folder', async () => {
    // The spec's project layout: `masks/` is derived, deletable data, and nothing may write outside it.
    const cache = createMaskCache(memoryStorage());
    expect(cache.folderFor(trackWithPrompt(), source).startsWith('masks/')).toBe(true);
  });
});
