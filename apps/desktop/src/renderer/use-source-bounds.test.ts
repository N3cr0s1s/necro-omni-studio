import { describe, expect, it } from 'vitest';
import { FRAME_RATES } from '@nos/core';
import { boundsFrom } from './use-source-bounds.js';

/**
 * A probed length, expressed in the frames a clip counts in.
 *
 * The trims have consulted a bounds resolver since M2 and nothing ever supplied one, so this is the
 * conversion that finally connects them — and the rate is the part that is easy to get wrong, because it
 * belongs to the clip rather than to the file.
 */

describe('turning a probe into a bound', () => {
  it('takes a video´s own frame count, with no conversion to be wrong about', () => {
    expect(boundsFrom({ frames: 107 }, FRAME_RATES.WEB_30)).toEqual({ totalFrames: 107 });
  });

  it('prefers the frame count over the duration when both are known', () => {
    // The count is exact; seconds are a rounding waiting to happen.
    expect(boundsFrom({ frames: 107, seconds: 4.46 }, FRAME_RATES.WEB_30)).toEqual({ totalFrames: 107 });
  });

  it('converts seconds at the clip´s rate, not at a fixed one', () => {
    // Four seconds is 120 frames at 30 and 96 at 24. A hard-coded 30 would be right for a web project
    // and wrong for every other rate in the same document.
    expect(boundsFrom({ seconds: 4 }, FRAME_RATES.WEB_30)).toEqual({ totalFrames: 120 });
    expect(boundsFrom({ seconds: 4 }, FRAME_RATES.FILM_24)).toEqual({ totalFrames: 96 });
  });

  it('floors rather than rounds, so the last frame stays guarded', () => {
    // Reporting one frame more than exists un-guards precisely the frame a trim runs into.
    expect(boundsFrom({ seconds: 4.99 }, FRAME_RATES.WEB_30)).toEqual({ totalFrames: 149 });
  });

  it('leaves an unprobed source unbounded rather than bounding it at zero', () => {
    // Unbounded means "edit unchecked", which is the honest state before a probe lands. Zero would
    // refuse every edit on it.
    expect(boundsFrom(undefined, FRAME_RATES.WEB_30)).toBeUndefined();
    expect(boundsFrom({}, FRAME_RATES.WEB_30)).toBeUndefined();
  });

  it('leaves a source shorter than one frame unbounded', () => {
    expect(boundsFrom({ seconds: 0.01 }, FRAME_RATES.WEB_30)).toBeUndefined();
  });
});
