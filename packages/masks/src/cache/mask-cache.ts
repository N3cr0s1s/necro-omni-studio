import { type AssetPath, assetPath, endExclusive } from '@nos/core';
import type { MaskFrame, MaskPrompt, MaskTrack } from '../contracts/mask.js';
import { countsFromString, countsToString, isWellFormed } from '../codec/rle.js';

/**
 * The mask cache under `masks/`.
 *
 * Derived data, like `cache/`: deletable, rebuildable, and never the source of truth. The difference is
 * that rebuilding a mask costs a GPU pass over hundreds of frames, so the key has to be exact — a cache
 * that misses on an unchanged track would make the feature feel broken, and one that *hits* on a changed
 * track would show a mask of the wrong object.
 *
 * The key is therefore the source, the range and the prompts. Nothing else influences the output, and
 * anything that did would have to enter the key.
 */

/** A stable key for a track's cached masks. */
export function maskCacheKey(
  source: AssetPath,
  range: { readonly start: number; readonly end: number },
  prompts: readonly MaskPrompt[],
): string {
  const parts = [
    source,
    `${range.start}-${range.end}`,
    ...prompts.map(describePrompt),
  ];
  return `${hash(parts.join('|'))}`;
}

/**
 * Prompts contribute in the order they were added.
 *
 * Order matters to the model — a negative click refines whatever the previous positives selected — so
 * sorting them for a "stable" key would make two genuinely different results share one.
 */
function describePrompt(prompt: MaskPrompt): string {
  return prompt.kind === 'point'
    ? `p:${prompt.frame}:${round(prompt.x)}:${round(prompt.y)}:${prompt.include ? 1 : 0}`
    : `b:${prompt.frame}:${round(prompt.x)}:${round(prompt.y)}:${round(prompt.width)}:${round(prompt.height)}`;
}

/** Four decimals: finer than a click can be placed, coarse enough that float noise cannot miss the cache. */
function round(value: number): string {
  return value.toFixed(4);
}

/** FNV-1a. Short, dependency-free and stable across runs, which is all a cache key needs. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

/** Where a track's masks live. One folder per track, so deleting a track is deleting a folder. */
export function maskFolder(track: MaskTrack, key: string): AssetPath {
  return assetPath(`masks/${track.clip}/${track.id}-${key}`);
}

export function maskFramePath(folder: AssetPath, frame: number): AssetPath {
  // Zero-padded so a directory listing sorts in frame order, which is what makes the folder debuggable.
  return assetPath(`${folder}/${String(frame).padStart(6, '0')}.rle`);
}

/**
 * The on-disk form of one frame.
 *
 * A text line rather than a binary block: a mask is already compressed by the run-length coding, the file
 * is small, and being able to read one in a terminal has repeatedly been worth more than the bytes saved.
 */
export function serializeFrame(frame: MaskFrame): string {
  return `${frame.width} ${frame.height}\n${countsToString(frame.counts)}\n`;
}

export function parseFrame(frame: number, text: string): MaskFrame {
  const [header, counts] = text.split('\n');
  const [width, height] = (header ?? '').split(' ').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width === undefined || height === undefined) {
    throw new SyntaxError('a mask file starts with "<width> <height>"');
  }

  const parsed: MaskFrame = {
    frame: frame as MaskFrame['frame'],
    width,
    height,
    counts: countsFromString(counts ?? ''),
  };
  if (!isWellFormed(parsed)) {
    // A truncated file — a crash mid-write — must be treated as a miss rather than decoded into a mask
    // with a diagonal tear in it.
    throw new SyntaxError(`the mask for frame ${frame} does not cover ${width}×${height}`);
  }
  return parsed;
}

/**
 * Storage, abstracted.
 *
 * The cache logic is worth testing without a filesystem, and the desktop shell, the sidecar and a test all
 * have different ideas about where bytes live.
 */
export interface MaskStorage {
  read(path: AssetPath): Promise<string | undefined>;
  write(path: AssetPath, text: string): Promise<void>;
  list(folder: AssetPath): Promise<readonly AssetPath[]>;
  remove(folder: AssetPath): Promise<void>;
}

export interface MaskCache {
  /** Frames already cached for this track, in frame order. */
  load(track: MaskTrack, source: AssetPath): Promise<readonly MaskFrame[]>;
  save(track: MaskTrack, source: AssetPath, frames: readonly MaskFrame[]): Promise<AssetPath>;
  /** Drops a track's masks. Called when a track is deleted, never automatically. */
  evict(track: MaskTrack, source: AssetPath): Promise<void>;
  /** Where a track's masks would live, for showing the path in the inspector. */
  folderFor(track: MaskTrack, source: AssetPath): AssetPath;
}

export function createMaskCache(storage: MaskStorage): MaskCache {
  const folderOf = (track: MaskTrack, source: AssetPath): AssetPath =>
    maskFolder(track, maskCacheKey(source, { start: track.range.start, end: endExclusive(track.range) }, track.prompts));

  return {
    folderFor: folderOf,

    async load(track, source) {
      const folder = folderOf(track, source);
      const files = await storage.list(folder);
      const frames: MaskFrame[] = [];

      for (const file of files) {
        const frame = frameNumberOf(file);
        if (frame === undefined) continue;
        const text = await storage.read(file);
        if (text === undefined) continue;
        try {
          frames.push(parseFrame(frame, text));
        } catch {
          // A corrupt frame is a miss, not a failure: the alternative is refusing to show the 400 good
          // frames because one is torn.
          continue;
        }
      }

      return frames.sort((a, b) => a.frame - b.frame);
    },

    async save(track, source, frames) {
      const folder = folderOf(track, source);
      for (const frame of frames) {
        await storage.write(maskFramePath(folder, frame.frame), serializeFrame(frame));
      }
      return folder;
    },

    async evict(track, source) {
      await storage.remove(folderOf(track, source));
    },
  };
}

function frameNumberOf(path: AssetPath): number | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const match = /^(\d+)\.rle$/.exec(name);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}
