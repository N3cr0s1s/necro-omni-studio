import { describe, expect, it, vi } from 'vitest';
import type { WaveformPeaks } from '@nos/media';
import { WAVEFORM_COLOUR, drawWaveform, filmstripHeightFor, thumbnailsPerSecondFor } from './clip-strips.js';

/**
 * Drawing a waveform from cached peaks.
 *
 * The peaks are what the sidecar caches, because they are resolution-independent — one derivation
 * serves every zoom level. The picture is made here, at the width the clip is drawn, and these are the
 * rules that has: how buckets map to columns, what silence looks like, and that a clip narrower than a
 * bucket still draws something rather than nothing.
 */

interface Recorded {
  readonly rects: { x: number; y: number; w: number; h: number }[];
  readonly canvas: HTMLCanvasElement;
  fillStyle: string | undefined;
}

/** A canvas that records what was drawn, so the geometry can be asserted without a real one. */
function recordingCanvas(): Recorded {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const state: { fillStyle: string | undefined } = { fillStyle: undefined };

  const context = {
    set fillStyle(value: string) {
      state.fillStyle = value;
    },
    get fillStyle(): string {
      return state.fillStyle ?? '';
    },
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h });
    },
  };

  const canvas = { getContext: () => context } as unknown as HTMLCanvasElement;
  return {
    rects,
    canvas,
    get fillStyle() {
      return state.fillStyle;
    },
  } as Recorded;
}

/** Peaks whose min/max pairs the test states directly. */
function peaksOf(pairs: readonly (readonly [number, number])[], bucketsPerSecond = 100): WaveformPeaks {
  const flat = new Float32Array(pairs.length * 2);
  pairs.forEach(([min, max], index) => {
    flat[index * 2] = min;
    flat[index * 2 + 1] = max;
  });
  return { bucketsPerSecond, channels: 1, peaks: flat };
}

function draw(
  peaks: WaveformPeaks,
  options: { widthPx?: number; heightPx?: number; durationSeconds?: number; startSeconds?: number } = {},
) {
  const recorder = recordingCanvas();
  drawWaveform({
    peaks,
    widthPx: options.widthPx ?? 4,
    heightPx: options.heightPx ?? 20,
    ...(options.durationSeconds !== undefined ? { durationSeconds: options.durationSeconds } : {}),
    ...(options.startSeconds !== undefined ? { startSeconds: options.startSeconds } : {}),
    createCanvas: () => recorder.canvas,
  });
  return recorder;
}

describe('columns', () => {
  it('draws one column per pixel, not one per bucket', () => {
    // An audio clip on screen can span tens of thousands of buckets, and a path with that many points
    // costs more to rasterize than the rest of the timeline.
    const peaks = peaksOf(Array.from({ length: 5000 }, () => [-0.5, 0.5] as const));
    const recorder = draw(peaks, { widthPx: 40 });

    expect(recorder.rects).toHaveLength(40);
  });

  it('spans the full width even when there are fewer buckets than pixels', () => {
    const recorder = draw(
      peaksOf([
        [-1, 1],
        [-0.5, 0.5],
      ]),
      { widthPx: 10 },
    );
    expect(recorder.rects).toHaveLength(10);
  });

  it('takes the extremes within a column, so a transient is not averaged away', () => {
    // A drum hit occupying one bucket of fifty must still show as a peak; a mean would erase it.
    const quiet = Array.from({ length: 49 }, () => [-0.05, 0.05] as const);
    const recorder = draw(peaksOf([[-1, 1], ...quiet]), { widthPx: 1, heightPx: 20 });

    const only = recorder.rects[0];
    expect(only?.h).toBeCloseTo(20, 1);
  });
});

describe('silence', () => {
  it('draws a centre line rather than nothing', () => {
    // Nothing is indistinguishable from "the waveform has not arrived", which is a different thing the
    // user would respond to differently.
    const recorder = draw(
      peaksOf([
        [0, 0],
        [0, 0],
      ]),
      { widthPx: 4, heightPx: 20 },
    );

    expect(recorder.rects).toHaveLength(4);
    for (const rect of recorder.rects) expect(rect.h).toBeGreaterThanOrEqual(1);
  });

  it('centres it', () => {
    const recorder = draw(peaksOf([[0, 0]]), { widthPx: 1, heightPx: 20 });
    expect(recorder.rects[0]?.y).toBeCloseTo(10, 1);
  });
});

describe('degenerate input', () => {
  it('draws nothing for an empty file rather than failing', () => {
    const recorder = draw(peaksOf([]), { widthPx: 8 });
    expect(recorder.rects).toEqual([]);
  });

  it('survives a zero width', () => {
    expect(() => draw(peaksOf([[-1, 1]]), { widthPx: 0 })).not.toThrow();
  });

  it('returns nothing when the canvas has no 2d context', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(
      drawWaveform({ peaks: peaksOf([[-1, 1]]), widthPx: 4, heightPx: 20, createCanvas: () => canvas }),
    ).toBeUndefined();
  });
});

describe('trimmed clips', () => {
  it('draws only the part of the source the clip shows', () => {
    // A clip trimmed to its second half must not draw the first: the waveform is how a user finds the
    // beat they cut to.
    const loud = Array.from({ length: 100 }, () => [-1, 1] as const);
    const quiet = Array.from({ length: 100 }, () => [0, 0] as const);
    const peaks = peaksOf([...loud, ...quiet]);

    const firstHalf = draw(peaks, { widthPx: 1, heightPx: 20, startSeconds: 0, durationSeconds: 1 });
    const secondHalf = draw(peaks, { widthPx: 1, heightPx: 20, startSeconds: 1, durationSeconds: 1 });

    expect(firstHalf.rects[0]?.h).toBeGreaterThan(secondHalf.rects[0]!.h);
  });

  it('uses the whole file when no range is given', () => {
    const peaks = peaksOf([
      [-1, 1],
      [0, 0],
    ]);
    const recorder = draw(peaks, { widthPx: 2, heightPx: 20 });
    expect(recorder.rects[0]!.h).toBeGreaterThan(recorder.rects[1]!.h);
  });

  it('does not read past the end of the file', () => {
    // A clip longer than its source — after a retime, say — must not index out of the array.
    expect(() => draw(peaksOf([[-1, 1]]), { widthPx: 8, durationSeconds: 60 })).not.toThrow();
  });
});

describe('normalisation', () => {
  it('makes quiet material visible', () => {
    // Dialogue mastered at −20 dBFS draws a two-pixel line at unity gain, which a user cannot tell
    // from silence or from "not derived yet" — three states they would respond to differently.
    const quiet = peaksOf(Array.from({ length: 20 }, () => [-0.1, 0.1] as const));
    const recorder = draw(quiet, { widthPx: 1, heightPx: 40 });

    expect(recorder.rects[0]?.h).toBeGreaterThan(30);
  });

  it('keeps the quiet parts of a track quiet', () => {
    // Scaled by the whole file, not by what is on screen: within one recording, a whisper must still
    // look smaller than a shout.
    const mixed = peaksOf([...Array.from({ length: 10 }, () => [-1, 1] as const), [-0.1, 0.1]]);
    const loud = draw(mixed, { widthPx: 1, heightPx: 40, startSeconds: 0, durationSeconds: 0.1 });
    const soft = draw(mixed, { widthPx: 1, heightPx: 40, startSeconds: 0.1, durationSeconds: 0.01 });

    expect(soft.rects[0]!.h).toBeLessThan(loud.rects[0]!.h / 2);
  });

  it('does not turn dither noise into a wall', () => {
    // Amplifying a −60 dBFS floor to full height would show an empty take as a loud one.
    const noise = peaksOf(Array.from({ length: 20 }, () => [-0.001, 0.001] as const));
    const recorder = draw(noise, { widthPx: 1, heightPx: 40 });

    expect(recorder.rects[0]!.h).toBeLessThan(10);
  });

  it('never draws outside the canvas', () => {
    const hot = peaksOf([
      [-0.2, 0.2],
      [-1, 1],
    ]);
    const recorder = draw(hot, { widthPx: 2, heightPx: 40 });

    for (const rect of recorder.rects) {
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.h).toBeLessThanOrEqual(40);
    }
  });

  it('can be turned off', () => {
    const recorder = recordingCanvas();
    drawWaveform({
      peaks: peaksOf([[-0.1, 0.1]]),
      widthPx: 1,
      heightPx: 40,
      normalise: false,
      createCanvas: () => recorder.canvas,
    });

    // A peak of 0.1 reaches a tenth of the half-height on each side of the centre.
    expect(recorder.rects[0]!.h).toBeCloseTo(4, 0);
  });
});

describe('colour', () => {
  it('uses the audio-domain accent by default', () => {
    const recorder = draw(peaksOf([[-1, 1]]), { widthPx: 1 });
    expect(recorder.fillStyle).toBe(WAVEFORM_COLOUR);
  });
});

describe('filmstrip specs', () => {
  it('leaves room for the label and badges above it', () => {
    expect(filmstripHeightFor(84)).toBeLessThan(84);
  });

  it('stays visible on a short track', () => {
    expect(filmstripHeightFor(24)).toBeGreaterThanOrEqual(16);
  });

  it('does not ask for a thumbnail taller than any track', () => {
    expect(filmstripHeightFor(4000)).toBeLessThanOrEqual(96);
  });

  it('asks for fewer thumbnails when zoomed out', () => {
    // A filmstrip is only useful when its thumbnails are distinguishable; at a minute per screen it is
    // a smear that costs a decode each to produce.
    const zoomedIn = thumbnailsPerSecondFor(1, 30);
    const zoomedOut = thumbnailsPerSecondFor(60, 30);

    expect(zoomedIn).toBeGreaterThan(zoomedOut);
  });

  it('stays within what the sidecar accepts', () => {
    for (const framesPerPixel of [0.01, 1, 10, 1000]) {
      const perSecond = thumbnailsPerSecondFor(framesPerPixel, 30);
      expect(perSecond).toBeGreaterThan(0);
      expect(perSecond).toBeLessThanOrEqual(4);
    }
  });

  it('quantises, so a small zoom change reuses the cached derivation', () => {
    // Every distinct spec is a separate ffmpeg run and a separate cache entry. A continuous value would
    // derive a new filmstrip on every pixel of a zoom gesture.
    expect(thumbnailsPerSecondFor(1, 30)).toBe(thumbnailsPerSecondFor(1.001, 30));
  });
});

describe('the recording harness', () => {
  it('does not silently pass when nothing is drawn', () => {
    // Guards the tests above: a harness that recorded nothing would make every assertion vacuous.
    const recorder = draw(peaksOf([[-1, 1]]), { widthPx: 3 });
    expect(recorder.rects.length).toBeGreaterThan(0);
    expect(vi.isMockFunction(recorder.rects)).toBe(false);
  });
});
