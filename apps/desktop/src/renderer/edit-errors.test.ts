import { describe, expect, it } from 'vitest';
import { clipId, trackId } from '@nos/core';
import type { EditError } from '@nos/editing';
import { describeEditError } from './edit-errors.js';

/**
 * What a refused edit says.
 *
 * These are read in a one-line status bar while the user is still holding the pointer, so the bar is
 * low but specific: say what was refused, and where there is one, what would make it work. Nine of the
 * fourteen kinds used to fall through to the discriminant with its hyphens taken out — `the edit was
 * rejected: nothing to cut` — which is debug output wearing a sentence.
 */

/** Every kind the editing package declares, so a new one cannot be forgotten here. */
const EVERY_KIND: readonly EditError[] = [
  { kind: 'collision', track: trackId('V1'), withClip: clipId('c1') },
  { kind: 'track-locked', track: trackId('V1') },
  { kind: 'clip-not-found', clip: clipId('c1') },
  { kind: 'track-not-found', track: trackId('V1') },
  { kind: 'empty-result', clip: clipId('c1') },
  { kind: 'source-exhausted', clip: clipId('c1'), available: 4, requested: 12 },
  { kind: 'wrong-track-kind', track: trackId('V1'), accepts: ['audio'], received: 'video' },
  { kind: 'nothing-to-cut', track: trackId('V1') },
  { kind: 'no-free-track', kindWanted: 'audio' },
  { kind: 'duplicate-track', track: trackId('V1') },
  { kind: 'empty-name' },
  { kind: 'marker-not-found', frame: 47 },
  { kind: 'no-shared-cut', clips: [clipId('a'), clipId('b')] },
  { kind: 'already-linked', clip: clipId('c1') },
];

describe('every rejection', () => {
  it('is described in words rather than as its discriminant', () => {
    for (const error of EVERY_KIND) {
      const message = describeEditError(error);
      expect(message, error.kind).not.toContain('the edit was rejected');
      expect(message.length, error.kind).toBeGreaterThan(10);
    }
  });

  it('is lower case, because it sits mid-sentence in a status bar', () => {
    for (const error of EVERY_KIND) {
      expect(describeEditError(error)[0], error.kind).toBe(describeEditError(error)[0]?.toLowerCase());
    }
  });

  it('carries the numbers that make it actionable', () => {
    expect(describeEditError(EVERY_KIND[5]!)).toContain('4 frames left');
    expect(describeEditError(EVERY_KIND[5]!)).toContain('12 were asked for');
    expect(describeEditError(EVERY_KIND[8]!)).toContain('audio');
  });
});

describe('a kind it has never heard of', () => {
  it('still says something rather than throwing', () => {
    // The whole reason this is not the domain's describer: the shell is handed transition and
    // segmentation errors too, and one that throws turns a refused edit into a blank window.
    expect(() => describeEditError({ kind: 'not-adjacent' })).not.toThrow();
    expect(describeEditError({ kind: 'not-adjacent' })).toBe('the edit was rejected: not adjacent');
  });
});
