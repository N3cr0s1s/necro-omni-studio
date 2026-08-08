import type { MaskFrame } from '../contracts/mask.js';

/**
 * Run-length coding for binary masks.
 *
 * The spec's storage choice: "RLE vagy PNG sequence a `masks/` alá". RLE is the default because a
 * propagated mask is one object over hundreds of frames, and a full-resolution PNG per frame turns a
 * ten-second shot into hundreds of megabytes for data that is almost entirely one value.
 *
 * The layout is COCO's, deliberately: **column-major**, alternating run lengths, starting with a run of
 * zeros. Matching it means masks produced by any SAM-family tool decode here unchanged, and masks written
 * here are readable by the rest of the ecosystem — which matters far more than a marginally tighter
 * private format.
 */

/** Encodes a column-major bitmap. `1` is inside the mask. */
export function encodeRle(bitmap: Uint8Array, width: number, height: number): readonly number[] {
  if (bitmap.length !== width * height) {
    throw new RangeError(`bitmap of ${bitmap.length} does not match ${width}×${height}`);
  }

  const counts: number[] = [];
  // Always starts with a zero run, even an empty one. Without that convention the parity of the array
  // would carry the first pixel's value, and a decoder reading a foreign mask would invert it.
  let current = 0;
  let run = 0;

  for (let column = 0; column < width; column += 1) {
    for (let row = 0; row < height; row += 1) {
      const value = bitmap[row * width + column] === 0 ? 0 : 1;
      if (value === current) {
        run += 1;
      } else {
        counts.push(run);
        current = value;
        run = 1;
      }
    }
  }
  counts.push(run);
  return counts;
}

/** Decodes to a row-major bitmap, which is what an image or a texture upload wants. */
export function decodeRle(counts: readonly number[], width: number, height: number): Uint8Array {
  const bitmap = new Uint8Array(width * height);
  let value = 0;
  let index = 0;

  for (const run of counts) {
    if (!Number.isInteger(run) || run < 0) {
      throw new RangeError(`run length ${run} is not a non-negative integer`);
    }
    if (value === 1) {
      for (let offset = 0; offset < run; offset += 1) {
        const position = index + offset;
        if (position >= width * height) break;
        // Column-major on the wire, row-major in memory.
        const column = Math.floor(position / height);
        const row = position % height;
        bitmap[row * width + column] = 1;
      }
    }
    index += run;
    value = value === 0 ? 1 : 0;
  }

  return bitmap;
}

/** Pixels inside the mask, without decoding it. */
export function maskArea(counts: readonly number[]): number {
  let area = 0;
  for (let index = 1; index < counts.length; index += 2) area += counts[index] ?? 0;
  return area;
}

/** Whether a run-length array covers exactly the frame it claims to. */
export function isWellFormed(frame: MaskFrame): boolean {
  const total = frame.counts.reduce((sum, run) => sum + run, 0);
  return total === frame.width * frame.height && frame.counts.every((run) => Number.isInteger(run) && run >= 0);
}

/**
 * Uploads a mask as an 8-bit single-channel texture source.
 *
 * `255` rather than `1`: the compositor samples the mask as a colour channel, and a value of 1/255 reads
 * as black. This is the kind of mistake that produces a mask which is technically present and visually
 * absent.
 */
export function toAlpha(counts: readonly number[], width: number, height: number): Uint8Array {
  const bitmap = decodeRle(counts, width, height);
  const alpha = new Uint8Array(bitmap.length);
  for (let index = 0; index < bitmap.length; index += 1) alpha[index] = bitmap[index] === 1 ? 255 : 0;
  return alpha;
}

/**
 * The RGBA form a WebGL texture upload takes.
 *
 * The mask goes into every channel, not only alpha: an effect may sample it as `.r` (a coverage value) or
 * rely on `.a` (a cut-out), and a mask that worked in one shader and silently failed in the other would be
 * a miserable thing to debug.
 */
export function toRgba(counts: readonly number[], width: number, height: number): Uint8Array {
  const bitmap = decodeRle(counts, width, height);
  const rgba = new Uint8Array(bitmap.length * 4);
  for (let index = 0; index < bitmap.length; index += 1) {
    const value = bitmap[index] === 1 ? 255 : 0;
    rgba[index * 4] = value;
    rgba[index * 4 + 1] = value;
    rgba[index * 4 + 2] = value;
    rgba[index * 4 + 3] = value;
  }
  return rgba;
}

/** Encodes the counts as the compact string COCO uses, for a compact on-disk form. */
export function countsToString(counts: readonly number[]): string {
  return counts.join(',');
}

export function countsFromString(text: string): readonly number[] {
  if (text.trim() === '') return [];
  return text.split(',').map((entry) => {
    const value = Number(entry);
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`"${entry}" is not a run length`);
    }
    return value;
  });
}
