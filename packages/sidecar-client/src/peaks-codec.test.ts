import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PEAKS_HEADER_SIZE,
  PEAKS_MAGIC,
  PEAKS_VERSION,
  aggregateRange,
  bucketCountOf,
  bucketRange,
  decodePeaks,
  describePeaksError,
} from './peaks-codec.js';

/**
 * The fixture is produced by the *Python* encoder (see the generator invocation recorded in the
 * ledger), so these tests verify the real cross-language contract rather than this file's own
 * assumptions. A field-order, stride or endianness mistake on either side fails here.
 */
const fixturePath = fileURLToPath(new URL('./__fixtures__/ramp-stereo.peaks', import.meta.url));
const metaPath = fileURLToPath(new URL('./__fixtures__/ramp-stereo.json', import.meta.url));

interface FixtureMeta {
  readonly bucketsPerSecond: number;
  readonly channels: number;
  readonly bucketCount: number;
  readonly byteLength: number;
  readonly firstBucketCh0: readonly [number, number];
  readonly lastBucketCh0: readonly [number, number];
  readonly firstBucketCh1: readonly [number, number];
  readonly lastBucketCh1: readonly [number, number];
}

function loadFixture(): ArrayBuffer {
  const bytes = readFileSync(fixturePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as FixtureMeta;

/** Builds a payload in the documented layout, for the malformed-input cases. */
function buildPeaks(options: {
  magic?: string;
  version?: number;
  bucketsPerSecond?: number;
  channels?: number;
  bucketCount?: number;
  values?: readonly number[];
}): ArrayBuffer {
  const values = options.values ?? [];
  const buffer = new ArrayBuffer(PEAKS_HEADER_SIZE + values.length * 4);
  const view = new DataView(buffer);
  const magic = options.magic ?? PEAKS_MAGIC;
  for (let i = 0; i < 8; i += 1) view.setUint8(i, magic.charCodeAt(i) || 0);
  view.setUint32(8, options.version ?? PEAKS_VERSION, true);
  view.setUint32(12, options.bucketsPerSecond ?? 100, true);
  view.setUint32(16, options.channels ?? 1, true);
  view.setUint32(20, options.bucketCount ?? values.length / 2, true);
  view.setUint32(24, 0, true);
  const floats = new Float32Array(buffer, PEAKS_HEADER_SIZE);
  floats.set(values);
  return buffer;
}

describe('cross-language fixture written by the Python encoder', () => {
  it('decodes the header the sidecar wrote', () => {
    const result = decodePeaks(loadFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bucketsPerSecond).toBe(meta.bucketsPerSecond);
    expect(result.value.channels).toBe(meta.channels);
    expect(bucketCountOf(result.value)).toBe(meta.bucketCount);
  });

  it('reads the exact float payload length', () => {
    const buffer = loadFixture();
    expect(buffer.byteLength).toBe(meta.byteLength);
    const result = decodePeaks(buffer);
    if (!result.ok) throw new Error('fixture failed to decode');
    expect(result.value.peaks.length).toBe(meta.bucketCount * meta.channels * 2);
  });

  it('reads channel 0 min/max at both ends, proving the stride and layout match', () => {
    const result = decodePeaks(loadFixture());
    if (!result.ok) throw new Error('fixture failed to decode');

    const first = bucketRange(result.value, 0, 0);
    expect(first.min).toBeCloseTo(meta.firstBucketCh0[0], 6);
    expect(first.max).toBeCloseTo(meta.firstBucketCh0[1], 6);

    const last = bucketRange(result.value, 0, meta.bucketCount - 1);
    expect(last.min).toBeCloseTo(meta.lastBucketCh0[0], 6);
    expect(last.max).toBeCloseTo(meta.lastBucketCh0[1], 6);
  });

  it('reads channel 1 separately, proving the layout is channel-major', () => {
    // The signal is deliberately different per channel: if the reader treated the payload as
    // interleaved-by-bucket, channel 1 would read channel 0's values here.
    const result = decodePeaks(loadFixture());
    if (!result.ok) throw new Error('fixture failed to decode');

    const first = bucketRange(result.value, 1, 0);
    expect(first.min).toBeCloseTo(meta.firstBucketCh1[0], 6);
    expect(first.max).toBeCloseTo(meta.firstBucketCh1[1], 6);

    const last = bucketRange(result.value, 1, meta.bucketCount - 1);
    expect(last.min).toBeCloseTo(meta.lastBucketCh1[0], 6);
    expect(last.max).toBeCloseTo(meta.lastBucketCh1[1], 6);
  });

  it('sees a monotonically rising ramp on channel 0', () => {
    const result = decodePeaks(loadFixture());
    if (!result.ok) throw new Error('fixture failed to decode');

    let previous = -Infinity;
    for (let bucket = 0; bucket < meta.bucketCount; bucket += 1) {
      const { max } = bucketRange(result.value, 0, bucket);
      expect(max).toBeGreaterThan(previous);
      previous = max;
    }
  });
});

describe('malformed input', () => {
  it('rejects a payload shorter than the header', () => {
    const result = decodePeaks(new ArrayBuffer(8));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('too-short');
  });

  it('rejects a wrong magic', () => {
    const result = decodePeaks(buildPeaks({ magic: 'NOTPEAK\0' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('bad-magic');
  });

  it('rejects an unsupported version rather than guessing the layout', () => {
    const result = decodePeaks(buildPeaks({ version: 99 }));
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'unsupported-version') {
      expect(result.error.version).toBe(99);
    }
  });

  it('detects truncation, which a crash mid-write leaves behind', () => {
    const result = decodePeaks(buildPeaks({ bucketCount: 10, channels: 1, values: [0, 1] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('truncated');
  });

  it('describes every error kind for a dialog', () => {
    for (const error of [
      { kind: 'too-short', length: 4 },
      { kind: 'bad-magic' },
      { kind: 'unsupported-version', version: 2 },
      { kind: 'truncated', expected: 10, actual: 2 },
    ] as const) {
      expect(describePeaksError(error).length).toBeGreaterThan(0);
    }
  });

  it('accepts an empty but well-formed payload', () => {
    const result = decodePeaks(buildPeaks({ bucketCount: 0, channels: 1, values: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(bucketCountOf(result.value)).toBe(0);
  });
});

/** Compares a min/max pair with float32 tolerance. */
function expectRange(actual: { readonly min: number; readonly max: number }, min: number, max: number): void {
  expect(actual.min).toBeCloseTo(min, 6);
  expect(actual.max).toBeCloseTo(max, 6);
}

describe('bucketRange', () => {
  const data = decodePeaks(
    buildPeaks({ channels: 1, bucketCount: 3, values: [-0.5, 0.5, -1, 1, -0.1, 0.2] }),
  );

  it('reads the requested bucket', () => {
    if (!data.ok) throw new Error('setup failed');
    expectRange(bucketRange(data.value, 0, 1), -1, 1);
  });

  it('clamps an out-of-range index instead of painting a spike from undefined', () => {
    // The renderer derives bucket indices from scroll and zoom; an off-by-one at a clip edge is
    // routine, and reading past the array would produce a visible artifact.
    if (!data.ok) throw new Error('setup failed');
    expectRange(bucketRange(data.value, 0, -5), -0.5, 0.5);
    expectRange(bucketRange(data.value, 0, 99), -0.1, 0.2);
  });

  it('returns silence for a channel that does not exist', () => {
    if (!data.ok) throw new Error('setup failed');
    expect(bucketRange(data.value, 4, 0)).toEqual({ min: 0, max: 0 });
  });
});

describe('aggregateRange', () => {
  const data = decodePeaks(
    buildPeaks({ channels: 1, bucketCount: 4, values: [-0.2, 0.2, -0.9, 0.1, -0.1, 0.8, 0, 0.05] }),
  );

  it('takes the extremes across the range, preserving transients', () => {
    // Averaging would flatten a drum track into a featureless block, telling the user nothing
    // about where the hits are.
    if (!data.ok) throw new Error('setup failed');
    expectRange(aggregateRange(data.value, 0, 0, 3), -0.9, 0.8);
  });

  it('handles a single-bucket range', () => {
    if (!data.ok) throw new Error('setup failed');
    expectRange(aggregateRange(data.value, 0, 1, 1), -0.9, 0.1);
  });

  it('clamps a range extending past the data', () => {
    if (!data.ok) throw new Error('setup failed');
    expectRange(aggregateRange(data.value, 0, 2, 100), -0.1, 0.8);
  });

  it('returns silence for an empty dataset', () => {
    const empty = decodePeaks(buildPeaks({ channels: 1, bucketCount: 0, values: [] }));
    if (!empty.ok) throw new Error('setup failed');
    expect(aggregateRange(empty.value, 0, 0, 10)).toEqual({ min: 0, max: 0 });
  });
});
