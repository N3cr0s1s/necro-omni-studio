import type { WaveformPeaks } from '@nos/media';

/**
 * Drawing a waveform.
 *
 * The sidecar produces peaks, not pictures: a `.peaks` file is min/max pairs, which is the right thing
 * to cache because it is resolution-independent — one derivation serves every zoom level, where a
 * rendered image would have to be regenerated for each.
 *
 * So the picture is made here, at the size the clip is actually drawn. Separated from the hook that
 * fetches it because this is the part with rules worth testing: how a bucket range maps to a column,
 * what an empty file looks like, and that a clip narrower than one bucket still draws something.
 */

/**
 * Colour of the waveform body.
 *
 * A literal, and one of only two left in the application — because this is not styling. The waveform
 * is *pixels*, rasterised into a PNG and cached on disk beside the audio, so it cannot follow a theme
 * that changes at runtime any more than a video frame can: switching to light mode would have to
 * invalidate every cached strip to make a class name of it.
 *
 * Chosen to sit near the `chart-2` role audio uses elsewhere, so the strip reads as the same family
 * of thing as the clip it is drawn inside.
 */
export const WAVEFORM_COLOUR = '#38c1a4';

export interface WaveformImageOptions {
  readonly peaks: WaveformPeaks;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Seconds of the source the clip actually shows, so a trimmed clip draws only its own part. */
  readonly startSeconds?: number;
  readonly durationSeconds?: number;
  readonly colour?: string;
  /**
   * Scale quiet material up so it is visible, capped at {@link MAX_WAVEFORM_GAIN}.
   *
   * On by default. Dialogue mastered at −20 dBFS draws a two-pixel line at unity, which is
   * indistinguishable from silence and from "not derived yet" — three states a user would act on
   * differently. The gain is taken from the *whole file* rather than the visible range, so two cuts
   * of one recording still look alike and the quiet parts of a track still read as quiet.
   */
  readonly normalise?: boolean;
  /** Injected so a test can supply a canvas without a DOM. */
  readonly createCanvas?: (width: number, height: number) => HTMLCanvasElement;
}

/**
 * Ceiling on the normalisation gain.
 *
 * Without one, a file of dither noise at −60 dBFS would be amplified into a solid block that looks
 * like a loud track. Bounded, near-silence stays near the centre line, which is the truth.
 */
export const MAX_WAVEFORM_GAIN = 12;

/**
 * Renders peaks into a canvas, one column per pixel.
 *
 * A column per pixel rather than a path through every bucket: an audio clip on screen can span tens of
 * thousands of buckets, and a path with that many points costs more to rasterize than the whole rest of
 * the timeline. Aggregating to the pixel grid is both faster and what the eye sees anyway.
 */
export function drawWaveform(options: WaveformImageOptions): HTMLCanvasElement | undefined {
  const width = Math.max(1, Math.floor(options.widthPx));
  const height = Math.max(1, Math.floor(options.heightPx));

  const create =
    options.createCanvas ??
    ((w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h }));

  const canvas = create(width, height);
  const context = canvas.getContext('2d');
  if (context === null) return undefined;

  const { peaks, channels } = options.peaks;
  const pairsPerChannel = Math.floor(peaks.length / 2 / Math.max(1, channels));
  if (pairsPerChannel === 0) return canvas;

  const perSecond = options.peaks.bucketsPerSecond;
  const firstBucket = Math.max(0, Math.round((options.startSeconds ?? 0) * perSecond));
  const spanBuckets =
    options.durationSeconds === undefined
      ? pairsPerChannel - firstBucket
      : Math.round(options.durationSeconds * perSecond);
  const usable = Math.max(1, Math.min(pairsPerChannel - firstBucket, spanBuckets));

  context.fillStyle = options.colour ?? WAVEFORM_COLOUR;
  const middle = height / 2;
  const gain = options.normalise === false ? 1 : fileGain(peaks, pairsPerChannel);

  for (let column = 0; column < width; column += 1) {
    const from = firstBucket + Math.floor((column / width) * usable);
    const to = Math.max(from + 1, firstBucket + Math.floor(((column + 1) / width) * usable));

    let low = 0;
    let high = 0;
    for (let bucket = from; bucket < to && bucket < pairsPerChannel; bucket += 1) {
      // Channel-major min/max pairs; the first channel is enough for a clip body, and mixing them
      // would show a stereo file as louder than it is.
      const min = peaks[bucket * 2] ?? 0;
      const max = peaks[bucket * 2 + 1] ?? 0;
      if (min < low) low = min;
      if (max > high) high = max;
    }

    // Clamped after the gain: a file whose peak sits just below the cap can still have one bucket
    // that would otherwise draw outside the canvas.
    const top = middle - Math.min(1, high * gain) * middle;
    const bottom = middle - Math.max(-1, low * gain) * middle;
    // At least one pixel: silence should read as a centre line rather than as nothing, which is
    // indistinguishable from "the waveform has not arrived".
    context.fillRect(column, top, 1, Math.max(1, bottom - top));
  }

  return canvas;
}

/**
 * Gain that brings the file's loudest bucket to full height, within the cap.
 *
 * Computed over the whole file, not the drawn range, so scrolling or trimming never changes how
 * loud a clip looks — a waveform whose scale moved under the cursor would be actively misleading.
 */
function fileGain(peaks: Float32Array, pairs: number): number {
  let loudest = 0;
  for (let index = 0; index < pairs * 2; index += 1) {
    const magnitude = Math.abs(peaks[index] ?? 0);
    if (magnitude > loudest) loudest = magnitude;
  }
  if (loudest <= 0) return 1;
  return Math.min(MAX_WAVEFORM_GAIN, 1 / loudest);
}

/**
 * How tall a filmstrip should be for a track.
 *
 * Derived once per track height rather than per clip: the sidecar caches by spec, so asking for a
 * different height per clip would produce a separate derivation for every clip on the timeline.
 */
export function filmstripHeightFor(trackHeightPx: number): number {
  // A little under the track, so the label and the badges still read over it.
  return Math.max(16, Math.min(96, Math.round(trackHeightPx - 18)));
}

/**
 * Thumbnails per second for a zoom level.
 *
 * Tied to zoom because a filmstrip is only useful when its thumbnails are distinguishable: one per
 * second is right at a normal zoom and useless when a minute fits on screen, where it becomes a smear
 * that costs a decode per thumbnail to produce.
 */
export function thumbnailsPerSecondFor(framesPerPixel: number, frameRate: number): number {
  const secondsPerPixel = framesPerPixel / Math.max(1, frameRate);
  // Roughly one thumbnail per 60 px, clamped to what the sidecar accepts.
  const perSecond = 1 / Math.max(0.05, secondsPerPixel * 60);
  return Math.max(0.1, Math.min(4, Math.round(perSecond * 10) / 10));
}
