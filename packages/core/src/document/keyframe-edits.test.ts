import { describe, expect, it } from 'vitest';
import { frameIndex } from '../time/frame-time.js';
import { keyframeId } from './ids.js';
import type { AnimatableNumber, Keyframe } from './params.js';
import { animatedNumber, evaluateAt, staticNumber } from './params.js';
import {
  addKeyframeAt,
  cycleKeyframeEasing,
  editKeyframe,
  keyframeById,
  removeKeyframe,
} from './keyframe-edits.js';

/**
 * Editing keyframes.
 *
 * The value edit is the one that was missing, and its absence was not a gap in a control — it made
 * animation unauthorable. A parameter's slider is disabled once it is keyframed, so between the two
 * there was no way to give a marker a number, and every animation could only hold whatever value
 * happened to be current when it was created.
 */

const marker = (id: string, frame: number, value: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({
  id: keyframeId(id),
  frame: frameIndex(frame),
  value,
  ease,
});

/** A fade: 1 at frame 0, 0 at frame 100. */
const fade = (): AnimatableNumber => animatedNumber([marker('a', 0, 1), marker('b', 100, 0)]);

const valuesOf = (param: AnimatableNumber): number[] =>
  param.kind === 'animated' ? param.keyframes.map((keyframe) => keyframe.value) : [];

const framesOf = (param: AnimatableNumber): number[] =>
  param.kind === 'animated' ? param.keyframes.map((keyframe) => keyframe.frame as number) : [];

describe('changing a value', () => {
  it('is possible at all, which is the point', () => {
    const edited = editKeyframe(fade(), keyframeId('b'), { value: 0.5 });
    expect(valuesOf(edited)).toEqual([1, 0.5]);
  });

  it('changes what the animation evaluates to in between', () => {
    // The assertion that matters: an edited marker has to reach the render, not merely the list.
    const edited = editKeyframe(fade(), keyframeId('b'), { value: 0.5 });
    expect(evaluateAt(edited, frameIndex(50))).toBeCloseTo(0.75, 5);
  });

  it('leaves every other marker alone', () => {
    const edited = editKeyframe(fade(), keyframeId('b'), { value: 0.5 });
    expect(keyframeById(edited, keyframeId('a'))).toEqual(marker('a', 0, 1));
  });

  it('accepts a negative value, because parameters are not all in [0, 1]', () => {
    // Pan is −1…1, position is in pixels either side of centre. Clamping here would be this file
    // deciding a range it cannot know.
    expect(valuesOf(editKeyframe(fade(), keyframeId('a'), { value: -3 }))).toEqual([-3, 0]);
  });

  it('refuses a value that is not a number, rather than storing it', () => {
    // `NaN` propagates through the interpolation to every frame in both neighbouring segments, and a
    // `NaN` uniform makes a shader draw nothing — a blank picture with no error to explain it.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(valuesOf(editKeyframe(fade(), keyframeId('a'), { value: bad }))).toEqual([1, 0]);
    }
  });
});

describe('moving a marker', () => {
  it('keeps the list sorted, so the evaluator can still binary-search it', () => {
    const moved = editKeyframe(fade(), keyframeId('a'), { frame: frameIndex(200) });
    expect(framesOf(moved)).toEqual([100, 200]);
  });

  it('never lands before the clip starts', () => {
    const moved = editKeyframe(fade(), keyframeId('b'), { frame: frameIndex(-40) });
    expect(framesOf(moved)).toContain(0);
  });

  it('replaces rather than corrupting when dropped onto an occupied frame', () => {
    // A drag that lands on a neighbour is a normal accident; throwing mid-gesture is not an answer.
    const collided = editKeyframe(fade(), keyframeId('b'), { frame: frameIndex(0) });
    expect(framesOf(collided)).toEqual([0]);
    expect(valuesOf(collided)).toEqual([0]);
  });
});

describe('changing an easing', () => {
  it('cycles through the modes the spec fixes for v1', () => {
    let param = fade();
    const seen: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      param = cycleKeyframeEasing(param, keyframeId('a'));
      seen.push(keyframeById(param, keyframeId('a'))!.ease);
    }
    expect(seen).toEqual(['ease-in', 'ease-out', 'ease-in-out', 'hold', 'linear', 'ease-in']);
  });

  it('restarts at linear for an easing this build does not know', () => {
    // How a project written by a build with Bezier support degrades, rather than sticking.
    const exotic = animatedNumber([marker('a', 0, 1, 'bezier' as Keyframe['ease'])]);
    expect(keyframeById(cycleKeyframeEasing(exotic, keyframeId('a')), keyframeId('a'))?.ease).toBe('linear');
  });

  it('changes only the marker asked for', () => {
    const cycled = cycleKeyframeEasing(fade(), keyframeId('b'));
    expect(keyframeById(cycled, keyframeId('a'))?.ease).toBe('linear');
  });
});

describe('adding a marker', () => {
  it('takes the value the curve already has there, so the animation does not change', () => {
    const added = addKeyframeAt(fade(), frameIndex(50));
    expect(evaluateAt(added, frameIndex(50))).toBeCloseTo(0.5, 5);
    expect(evaluateAt(added, frameIndex(25))).toBeCloseTo(0.75, 5);
  });

  it('takes an explicit value when one is given', () => {
    expect(evaluateAt(addKeyframeAt(fade(), frameIndex(50), 0.9), frameIndex(50))).toBe(0.9);
  });

  it('turns a constant into an animation', () => {
    // The other half of "animate this": the inspector's toggle writes the first marker, and a second
    // one has to be addable from the lane or the parameter can never actually move.
    const added = addKeyframeAt(staticNumber(0.25), frameIndex(30));
    expect(added.kind).toBe('animated');
    expect(valuesOf(added)).toEqual([0.25]);
  });

  it('does nothing where a marker already is, rather than stacking two', () => {
    expect(framesOf(addKeyframeAt(fade(), frameIndex(0)))).toEqual([0, 100]);
  });
});

describe('removing a marker', () => {
  it('leaves the rest animated, keeping the easing the user chose', () => {
    const left = removeKeyframe(fade(), keyframeId('b'));
    expect(left.kind).toBe('animated');
    expect(framesOf(left)).toEqual([0]);
  });
});

describe('an id that is no longer there', () => {
  it('is ignored rather than thrown on', () => {
    // Reached whenever an edit races the undo that removed its marker. An exception in a pointer
    // handler would take the timeline down for something the user cannot see.
    const gone = keyframeId('nope');
    expect(editKeyframe(fade(), gone, { value: 5 })).toEqual(fade());
    expect(cycleKeyframeEasing(fade(), gone)).toEqual(fade());
    expect(removeKeyframe(fade(), gone)).toEqual(fade());
  });

  it('is ignored on a constant, which has no markers to find', () => {
    const constant = staticNumber(1);
    expect(editKeyframe(constant, keyframeId('a'), { value: 5 })).toBe(constant);
    expect(keyframeById(constant, keyframeId('a'))).toBeUndefined();
  });
});
