import { type Result, err, ok } from '@nos/core';
import type { WaveformPeaks } from '@nos/media';

/**
 * Reader for the `.peaks` format the sidecar writes.
 *
 * The layout is defined once, in `apps/sidecar/src/nos_sidecar/peaks.py`, and this is the other
 * half of that contract. A cross-language fixture test pins them together — a format written by one
 * language and read by another is exactly where a silent field-order or endianness mistake hides.
 *
 * ```
 * magic        8 bytes   "NOSPK1\0\0"
 * version      uint32    1
 * buckets/s    uint32
 * channels     uint32
 * bucketCount  uint32
 * reserved     uint32
 * data         float32[] channel-major, min/max interleaved per bucket
 * ```
 */

export const PEAKS_MAGIC = 'NOSPK1\0\0';
export const PEAKS_VERSION = 1;

/**
 * 8-byte magic plus five uint32 fields.
 *
 * Must match Python's `struct.Struct("<8sIIIII")` exactly. It is 28, not 32 — an easy number to get
 * wrong by eye, and getting it wrong shifts the entire float payload, which is why the
 * cross-language fixture test pins it.
 */
export const PEAKS_HEADER_SIZE = 28;

export type PeaksDecodeError =
  | { readonly kind: 'too-short'; readonly length: number }
  | { readonly kind: 'bad-magic' }
  | { readonly kind: 'unsupported-version'; readonly version: number }
  | { readonly kind: 'truncated'; readonly expected: number; readonly actual: number };

export function decodePeaks(buffer: ArrayBuffer): Result<WaveformPeaks, PeaksDecodeError> {
  if (buffer.byteLength < PEAKS_HEADER_SIZE) {
    return err({ kind: 'too-short', length: buffer.byteLength });
  }

  const view = new DataView(buffer);
  const magicBytes = new Uint8Array(buffer, 0, 8);
  let magic = '';
  for (const byte of magicBytes) magic += String.fromCharCode(byte);
  if (magic !== PEAKS_MAGIC) return err({ kind: 'bad-magic' });

  // Little-endian throughout: every target platform is little-endian, so the float payload can be
  // wrapped in a Float32Array with no per-sample conversion.
  const version = view.getUint32(8, true);
  if (version !== PEAKS_VERSION) return err({ kind: 'unsupported-version', version });

  const bucketsPerSecond = view.getUint32(12, true);
  const channels = view.getUint32(16, true);
  const bucketCount = view.getUint32(20, true);

  const expectedFloats = bucketCount * channels * 2;
  const actualFloats = (buffer.byteLength - PEAKS_HEADER_SIZE) / 4;
  if (actualFloats !== expectedFloats) {
    return err({ kind: 'truncated', expected: expectedFloats, actual: actualFloats });
  }

  // `slice` rather than a view over the original buffer, for two reasons: the payload outlives the
  // response body and a view would pin the whole ArrayBuffer in memory, and the copy starts at
  // offset 0 so `Float32Array`'s 4-byte alignment requirement holds regardless of the header size.
  const peaks = new Float32Array(buffer.slice(PEAKS_HEADER_SIZE));

  return ok({ bucketsPerSecond, channels, peaks });
}

/**
 * Reads one bucket's min/max for a channel.
 *
 * Bounds-checked and clamped rather than trusting the index: the renderer computes bucket indices
 * from a scroll position and a zoom level, and an off-by-one at the right edge of a clip would
 * otherwise read `undefined` and paint a spike.
 */
export function bucketRange(
  data: WaveformPeaks,
  channel: number,
  bucket: number,
): { readonly min: number; readonly max: number } {
  const bucketCount = bucketCountOf(data);
  if (bucketCount === 0 || channel < 0 || channel >= data.channels) {
    return { min: 0, max: 0 };
  }
  const clamped = Math.min(Math.max(bucket, 0), bucketCount - 1);
  const base = (channel * bucketCount + clamped) * 2;
  return { min: data.peaks[base] ?? 0, max: data.peaks[base + 1] ?? 0 };
}

export function bucketCountOf(data: WaveformPeaks): number {
  if (data.channels === 0) return 0;
  return data.peaks.length / (data.channels * 2);
}

/**
 * Reduces a bucket range to a single min/max, for drawing at a zoom level coarser than the stored
 * resolution.
 *
 * Taking the extremes across the range rather than averaging is what preserves transients: an
 * averaged waveform of a drum track looks like a flat block, which tells the user nothing about
 * where the hits are.
 */
export function aggregateRange(
  data: WaveformPeaks,
  channel: number,
  fromBucket: number,
  toBucket: number,
): { readonly min: number; readonly max: number } {
  const bucketCount = bucketCountOf(data);
  if (bucketCount === 0) return { min: 0, max: 0 };

  const start = Math.min(Math.max(Math.floor(fromBucket), 0), bucketCount - 1);
  const end = Math.min(Math.max(Math.ceil(toBucket), start), bucketCount - 1);

  let min = Infinity;
  let max = -Infinity;
  for (let bucket = start; bucket <= end; bucket += 1) {
    const range = bucketRange(data, channel, bucket);
    if (range.min < min) min = range.min;
    if (range.max > max) max = range.max;
  }

  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

export function describePeaksError(error: PeaksDecodeError): string {
  switch (error.kind) {
    case 'too-short':
      return `peaks file is only ${error.length} bytes, shorter than its header`;
    case 'bad-magic':
      return 'file is not a peaks file';
    case 'unsupported-version':
      return `peaks format version ${error.version} is not supported`;
    case 'truncated':
      return `peaks file holds ${error.actual} values, expected ${error.expected}`;
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled peaks error ${JSON.stringify(unreachable)}`);
    }
  }
}
