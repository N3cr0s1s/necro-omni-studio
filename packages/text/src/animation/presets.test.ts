import { describe, expect, it } from 'vitest';
import {
  type TextAnimation,
  animatedNumber,
  evaluateAt,
  frameIndex,
  isAnimated,
  keyframeId,
  staticNumber,
} from '@nos/core';
import {
  DEFAULT_REST,
  SCALE_FROM,
  SLIDE_DISTANCE,
  TEXT_PRESETS,
  createKeyframeIdFactory,
  generatePreset,
  mergeGeneratedKeyframes,
  presetRange,
  removeRange,
} from './presets.js';

function animation(overrides: Partial<TextAnimation> = {}): TextAnimation {
  return { preset: 'fade', durationFrames: 12, ease: 'linear', ...overrides };
}

function generate(
  overrides: Partial<TextAnimation> = {},
  phase: 'in' | 'out' = 'in',
  clipDurationFrames = 120,
) {
  return generatePreset({
    animation: animation(overrides),
    phase,
    clipDurationFrames,
    rest: DEFAULT_REST,
    nextId: createKeyframeIdFactory(),
  });
}

describe('fade', () => {
  it('animates opacity from zero to rest on the way in', () => {
    const curves = generate({ preset: 'fade' });
    expect(curves).toHaveLength(1);
    expect(curves[0]!.channel).toBe('opacity');
    expect(curves[0]!.keyframes.map((k) => k.value)).toEqual([0, 1]);
  });

  it('reverses for the out phase', () => {
    const curves = generate({ preset: 'fade' }, 'out');
    expect(curves[0]!.keyframes.map((k) => k.value)).toEqual([1, 0]);
  });

  it('anchors an in animation to the clip start', () => {
    const curves = generate({ preset: 'fade', durationFrames: 12 }, 'in', 120);
    expect(curves[0]!.keyframes.map((k) => k.frame)).toEqual([0, 12]);
  });

  it('anchors an out animation to the clip end', () => {
    const curves = generate({ preset: 'fade', durationFrames: 12 }, 'out', 120);
    expect(curves[0]!.keyframes.map((k) => k.frame)).toEqual([108, 120]);
  });
});

describe('slide', () => {
  it('animates y and opacity, leaving other channels alone', () => {
    // A slide must not silently pin scale, or applying it would undo hand-authored animation.
    const curves = generate({ preset: 'slide', direction: 'up' });
    expect(curves.map((curve) => curve.channel).sort()).toEqual(['opacity', 'y']);
  });

  it('arrives from below when sliding up', () => {
    const curves = generate({ preset: 'slide', direction: 'up' });
    const y = curves.find((curve) => curve.channel === 'y')!;
    expect(y.keyframes[0]!.value).toBeCloseTo(SLIDE_DISTANCE, 6);
    expect(y.keyframes[1]!.value).toBeCloseTo(0, 6);
  });

  it('arrives from above when sliding down', () => {
    const curves = generate({ preset: 'slide', direction: 'down' });
    const y = curves.find((curve) => curve.channel === 'y')!;
    expect(y.keyframes[0]!.value).toBeCloseTo(-SLIDE_DISTANCE, 6);
  });

  it('uses the x channel for horizontal directions', () => {
    for (const direction of ['left', 'right'] as const) {
      const curves = generate({ preset: 'slide', direction });
      expect(curves.some((curve) => curve.channel === 'x')).toBe(true);
      expect(curves.some((curve) => curve.channel === 'y')).toBe(false);
    }
  });

  it('defaults to up when no direction is given', () => {
    const curves = generate({ preset: 'slide' });
    expect(curves.find((curve) => curve.channel === 'y')!.keyframes[0]!.value).toBeCloseTo(
      SLIDE_DISTANCE,
      6,
    );
  });

  it('animates toward the authored rest position, not toward zero', () => {
    // Otherwise applying a preset would move a deliberately offset title back to centre.
    const curves = generatePreset({
      animation: animation({ preset: 'slide', direction: 'up' }),
      phase: 'in',
      clipDurationFrames: 120,
      rest: { ...DEFAULT_REST, y: 0.8 },
      nextId: createKeyframeIdFactory(),
    });
    const y = curves.find((curve) => curve.channel === 'y')!;
    expect(y.keyframes[1]!.value).toBeCloseTo(0.8, 6);
    expect(y.keyframes[0]!.value).toBeCloseTo(0.8 + SLIDE_DISTANCE, 6);
  });
});

describe('scale', () => {
  it('pairs scale with a fade, so it does not read as a glitch', () => {
    const curves = generate({ preset: 'scale' });
    expect(curves.map((curve) => curve.channel).sort()).toEqual(['opacity', 'scale']);
  });

  it('grows from below rest scale', () => {
    const curves = generate({ preset: 'scale' });
    const scale = curves.find((curve) => curve.channel === 'scale')!;
    expect(scale.keyframes[0]!.value).toBeCloseTo(SCALE_FROM, 6);
    expect(scale.keyframes[1]!.value).toBeCloseTo(1, 6);
  });
});

describe('typewriter', () => {
  it('drives reveal rather than a transform', () => {
    // The visible character count changes, which no transform expresses.
    const curves = generate({ preset: 'typewriter' });
    expect(curves).toHaveLength(1);
    expect(curves[0]!.channel).toBe('reveal');
    expect(curves[0]!.keyframes.map((k) => k.value)).toEqual([0, 1]);
  });

  it('un-types on the way out', () => {
    const curves = generate({ preset: 'typewriter' }, 'out');
    expect(curves[0]!.keyframes.map((k) => k.value)).toEqual([1, 0]);
  });
});

describe('degenerate input', () => {
  it('generates nothing for the none preset', () => {
    expect(generate({ preset: 'none' })).toEqual([]);
  });

  it('generates nothing for a zero duration', () => {
    expect(generate({ preset: 'fade', durationFrames: 0 })).toEqual([]);
  });

  it('clamps a duration longer than the clip', () => {
    // Otherwise the keyframes would sit outside the clip and never be reached.
    const curves = generate({ preset: 'fade', durationFrames: 500 }, 'in', 60);
    expect(curves[0]!.keyframes.map((k) => k.frame)).toEqual([0, 60]);
  });

  it('keeps an out animation inside a short clip', () => {
    const curves = generate({ preset: 'fade', durationFrames: 500 }, 'out', 60);
    expect(curves[0]!.keyframes.map((k) => k.frame)).toEqual([0, 60]);
  });

  it('degrades an unrecognized easing to linear', () => {
    // The document stores easing as a free string for forward compatibility.
    const curves = generate({ preset: 'fade', ease: 'bezier' });
    expect(curves[0]!.keyframes[0]!.ease).toBe('linear');
  });

  it('covers every preset the spec lists', () => {
    expect([...TEXT_PRESETS]).toEqual(['none', 'fade', 'slide', 'scale', 'typewriter']);
  });
});

describe('easing placement', () => {
  it('puts the easing on the first keyframe, which governs the segment', () => {
    const curves = generate({ preset: 'fade', ease: 'ease-out' });
    expect(curves[0]!.keyframes[0]!.ease).toBe('ease-out');
    // The last keyframe's easing governs nothing, so it stays neutral.
    expect(curves[0]!.keyframes[1]!.ease).toBe('linear');
  });

  it('produces a curve the core evaluator reads back correctly', () => {
    // The generated keyframes must be ordinary document keyframes — the whole point of generating rather
    // than interpreting at render time.
    const curves = generate({ preset: 'fade', durationFrames: 10, ease: 'linear' });
    const param = animatedNumber(curves[0]!.keyframes);
    expect(evaluateAt(param, frameIndex(0))).toBeCloseTo(0, 6);
    expect(evaluateAt(param, frameIndex(5))).toBeCloseTo(0.5, 6);
    expect(evaluateAt(param, frameIndex(10))).toBeCloseTo(1, 6);
  });
});

describe('ids', () => {
  it('gives every generated keyframe a unique id', () => {
    const curves = generate({ preset: 'scale' });
    const ids = curves.flatMap((curve) => curve.keyframes.map((k) => k.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is deterministic, so a generated document round-trips identically', () => {
    const first = generate({ preset: 'fade' });
    const second = generate({ preset: 'fade' });
    expect(first).toEqual(second);
  });
});

describe('mergeGeneratedKeyframes', () => {
  const generated = [
    { id: keyframeId('g1'), frame: frameIndex(0), value: 0, ease: 'linear' as const },
    { id: keyframeId('g2'), frame: frameIndex(10), value: 1, ease: 'linear' as const },
  ];

  it('adds a curve to a previously static parameter', () => {
    const merged = mergeGeneratedKeyframes(staticNumber(1), generated);
    expect(isAnimated(merged) && merged.keyframes).toHaveLength(2);
  });

  it('keeps keyframes outside the generated range', () => {
    // Applying an in-animation must not destroy a hand-authored out-animation.
    const existing = animatedNumber([
      { id: keyframeId('e1'), frame: frameIndex(100), value: 1, ease: 'linear' },
      { id: keyframeId('e2'), frame: frameIndex(110), value: 0, ease: 'linear' },
    ]);
    const merged = mergeGeneratedKeyframes(existing, generated);
    expect(isAnimated(merged) && merged.keyframes.map((k) => k.frame)).toEqual([0, 10, 100, 110]);
  });

  it('replaces keyframes inside the generated range, which the preset defines', () => {
    const existing = animatedNumber([
      { id: keyframeId('old'), frame: frameIndex(5), value: 0.9, ease: 'linear' },
    ]);
    const merged = mergeGeneratedKeyframes(existing, generated);
    expect(isAnimated(merged) && merged.keyframes.map((k) => k.id)).toEqual(['g1', 'g2']);
  });

  it('is a no-op for an empty generated set', () => {
    const existing = staticNumber(1);
    expect(mergeGeneratedKeyframes(existing, [])).toBe(existing);
  });
});

describe('removeRange', () => {
  it('removes keyframes inside the range', () => {
    const existing = animatedNumber([
      { id: keyframeId('a'), frame: frameIndex(0), value: 0, ease: 'linear' },
      { id: keyframeId('b'), frame: frameIndex(10), value: 1, ease: 'linear' },
      { id: keyframeId('c'), frame: frameIndex(100), value: 1, ease: 'linear' },
    ]);
    const cleared = removeRange(existing, frameIndex(0), frameIndex(10));
    expect(isAnimated(cleared) && cleared.keyframes.map((k) => k.id)).toEqual(['c']);
  });

  it('identifies by range, not by id, so a dragged marker is still removed', () => {
    // The user may have moved the markers since applying the preset.
    const existing = animatedNumber([
      { id: keyframeId('moved'), frame: frameIndex(7), value: 0.4, ease: 'linear' },
    ]);
    const cleared = removeRange(existing, frameIndex(0), frameIndex(12));
    expect(isAnimated(cleared) && cleared.keyframes).toHaveLength(0);
  });

  it('leaves a static parameter alone', () => {
    const existing = staticNumber(1);
    expect(removeRange(existing, frameIndex(0), frameIndex(10))).toBe(existing);
  });

  it('returns the same object when nothing is in range', () => {
    const existing = animatedNumber([
      { id: keyframeId('a'), frame: frameIndex(50), value: 1, ease: 'linear' },
    ]);
    expect(removeRange(existing, frameIndex(0), frameIndex(10))).toBe(existing);
  });
});

describe('presetRange', () => {
  it('reports the range an in animation occupies', () => {
    expect(presetRange(animation({ durationFrames: 12 }), 'in', 120)).toEqual({
      start: 0,
      end: 12,
    });
  });

  it('reports the range an out animation occupies', () => {
    expect(presetRange(animation({ durationFrames: 12 }), 'out', 120)).toEqual({
      start: 108,
      end: 120,
    });
  });

  it('agrees with the generator on the boundaries', () => {
    // The two must not drift, or removing a preset would leave a stray keyframe behind.
    const config = animation({ preset: 'fade', durationFrames: 20 });
    const curves = generatePreset({
      animation: config,
      phase: 'out',
      clipDurationFrames: 90,
      rest: DEFAULT_REST,
      nextId: createKeyframeIdFactory(),
    });
    const range = presetRange(config, 'out', 90);
    expect(curves[0]!.keyframes[0]!.frame).toBe(range.start);
    expect(curves[0]!.keyframes[1]!.frame).toBe(range.end);
  });
});
