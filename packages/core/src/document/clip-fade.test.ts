import { describe, expect, it } from 'vitest';
import { type AudioClip, type Clip, NO_FADE, clipFade, fadeAmountAt, hasFade } from './clip.js';
import { clipId } from './ids.js';
import { staticNumber } from './params.js';
import { frameIndex } from '../time/frame-time.js';
import { spanFromBounds } from '../time/frame-span.js';
import { FRAME_RATES } from '../time/frame-rate.js';
import { assetPath } from './ids.js';

/**
 * Edge ramps.
 *
 * `fadeAmountAt` is deliberately the *position* in the ramp and not the multiplier a renderer
 * applies: sound and picture shape it differently, and what the two must agree on is where in the
 * ramp a frame falls. Everything here is about that agreement.
 */

function audio(fade?: { inFrames: number; outFrames: number }): AudioClip {
  return {
    kind: 'audio',
    id: clipId('a'),
    span: spanFromBounds(frameIndex(100), frameIndex(200)),
    label: 'a',
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.wav'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...(fade === undefined ? {} : { fade }),
  } as AudioClip;
}

describe('reading a clip’s fade', () => {
  it('answers no ramp when the field is absent, so no caller has to write `?? NO_FADE`', () => {
    expect(clipFade(audio())).toEqual(NO_FADE);
    expect(hasFade(audio())).toBe(false);
  });

  it('clamps a negative ramp to none rather than inverting it', () => {
    // A stored file is not a trusted input, and there is no renderer that can express a −5 frame
    // ramp — showing no fade is the only honest reading.
    expect(clipFade(audio({ inFrames: -5, outFrames: 10 }))).toEqual({ inFrames: 0, outFrames: 10 });
  });

  it('is a fade when either edge ramps', () => {
    expect(hasFade(audio({ inFrames: 10, outFrames: 0 }))).toBe(true);
    expect(hasFade(audio({ inFrames: 0, outFrames: 10 }))).toBe(true);
    expect(hasFade(audio({ inFrames: 0, outFrames: 0 }))).toBe(false);
  });
});

describe('where in its ramps a frame falls', () => {
  it('is full everywhere on a clip with no fade', () => {
    const clip = audio();
    expect(fadeAmountAt(clip, 0)).toBe(1);
    expect(fadeAmountAt(clip, 50)).toBe(1);
    expect(fadeAmountAt(clip, 100)).toBe(1);
  });

  it('rises from nothing at the in-point to full at the end of the ramp', () => {
    const clip = audio({ inFrames: 20, outFrames: 0 });
    expect(fadeAmountAt(clip, 0)).toBe(0);
    expect(fadeAmountAt(clip, 10)).toBeCloseTo(0.5);
    expect(fadeAmountAt(clip, 20)).toBe(1);
    expect(fadeAmountAt(clip, 60)).toBe(1);
  });

  it('falls to nothing at the out-point', () => {
    // The clip is 100 frames long, so the last 20 ramp down and frame 100 — the first frame the clip
    // no longer covers — is silence.
    const clip = audio({ inFrames: 0, outFrames: 20 });
    expect(fadeAmountAt(clip, 80)).toBe(1);
    expect(fadeAmountAt(clip, 81)).toBeCloseTo(0.95);
    expect(fadeAmountAt(clip, 90)).toBeCloseTo(0.5);
    expect(fadeAmountAt(clip, 100)).toBe(0);
  });

  it('takes the lower of two ramps that overlap on a short clip', () => {
    // 80 in and 80 out on a 100-frame clip: the two ramps cross, and the clip peaks in the middle
    // instead of jumping to full and back.
    const clip = audio({ inFrames: 80, outFrames: 80 });
    expect(fadeAmountAt(clip, 0)).toBe(0);
    expect(fadeAmountAt(clip, 50)).toBeCloseTo(0.625);
    expect(fadeAmountAt(clip, 100)).toBe(0);
    expect(fadeAmountAt(clip, 40)).toBeCloseTo(0.5);
  });

  it('stays inside zero and one outside the clip, which a stale playhead can ask for', () => {
    const clip = audio({ inFrames: 20, outFrames: 20 });
    expect(fadeAmountAt(clip, -30)).toBe(0);
    expect(fadeAmountAt(clip, 400)).toBe(0);
  });

  it('reads a clip of any kind, because a ramp means the same thing in both domains', () => {
    const still: Clip = {
      kind: 'image',
      id: clipId('i'),
      span: spanFromBounds(frameIndex(0), frameIndex(50)),
      label: 'i',
      enabled: true,
      effects: [],
      source: { asset: assetPath('media/a.png'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
      transform: {
        x: staticNumber(0),
        y: staticNumber(0),
        scale: staticNumber(1),
        rotation: staticNumber(0),
        opacity: staticNumber(1),
      },
      fade: { inFrames: 10, outFrames: 0 },
    } as Clip;
    expect(fadeAmountAt(still, 5)).toBeCloseTo(0.5);
  });
});
