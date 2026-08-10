import { describe, expect, it } from 'vitest';
import { describeCacheStats } from './derived-cache.js';

/**
 * What the row says it would reclaim.
 *
 * Separated from the transport so it can be checked without a running sidecar — the same split the
 * preview's own readouts use, and the reason those are testable at all.
 */
describe('describing the derived cache', () => {
  it('names the size and the count, which answer different questions', () => {
    // A hundred megabytes in four files is one long proxy; the same in four thousand is a filmstrip
    // of a long edit. The size alone does not distinguish them.
    expect(describeCacheStats({ bytes: 2_411_724, files: 40 })).toBe('2.30 MB in 40 files');
  });

  it('says nothing at all when the cache is empty', () => {
    // `undefined` rather than "0 B", so the caller disables the row instead of offering to remove
    // nothing — the rule the gap and crossfade rows already follow.
    expect(describeCacheStats({ bytes: 0, files: 0 })).toBeUndefined();
  });

  it('says nothing before the first read lands', () => {
    expect(describeCacheStats(undefined)).toBeUndefined();
  });

  it('counts one file in the singular', () => {
    expect(describeCacheStats({ bytes: 900, files: 1 })).toBe('900 B in 1 file');
  });
});
