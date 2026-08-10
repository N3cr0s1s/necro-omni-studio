// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_RATES, type FrameIndex, frameIndex } from '@nos/core';
import { type Transport, useTransport } from './use-transport.js';

afterEach(cleanup);

/**
 * Looping, per the mockups' `loop` beside the in and out points.
 *
 * The ordinary way a cut gets judged is watching the same four seconds twenty times. Playback stopped
 * at the out point, so each viewing cost a press of play *and* dragging the playhead back — two
 * gestures between every look at the thing being decided.
 *
 * Driven through the real hook with a fake clock, because the behaviour under test is what happens on
 * the frame the end is reached, and that is a decision inside an animation frame rather than a value
 * anything exposes.
 */

/** A hand-cranked clock and frame loop, so a test can step playback one tick at a time. */
function useFakeRaf() {
  const frames: (() => void)[] = [];
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(() => callback(0));
    return frames.length;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return {
    tick(): void {
      const next = frames.shift();
      if (next !== undefined) act(() => next());
    },
  };
}

function mount(options: { readonly loopFrom?: FrameIndex; readonly endFrame: number }) {
  let transport: Transport | undefined;
  function Probe(): null {
    transport = useTransport({
      frameRate: FRAME_RATES.WEB_30,
      endFrame: options.endFrame,
      ...(options.loopFrom === undefined ? {} : { loopFrom: options.loopFrom }),
    });
    return null;
  }
  render(<Probe />);
  return () => transport!;
}

describe('reaching the end of playback', () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => vi.restoreAllMocks());

  it('stops at the out point when looping is off', () => {
    const raf = useFakeRaf();
    const transport = mount({ endFrame: 30 });

    act(() => transport().play());
    now = 5000; // Well past thirty frames at 30 fps.
    raf.tick();

    expect(transport().playing).toBe(false);
    expect(transport().frame).toBe(30);
  });

  it('returns to the loop point instead, and keeps playing', () => {
    const raf = useFakeRaf();
    const transport = mount({ endFrame: 30, loopFrom: frameIndex(10) });

    act(() => transport().play());
    now = 5000;
    raf.tick();

    expect(transport().playing).toBe(true);
    expect(transport().frame).toBe(10);
  });

  it('re-anchors the clock, or the second pass would end immediately', () => {
    // The bug this guards: moving the frame without resetting the wall-clock anchor leaves elapsed
    // time counting from the original start, so the very next tick is still past the end and the loop
    // collapses to a stutter at the out point.
    const raf = useFakeRaf();
    const transport = mount({ endFrame: 30, loopFrom: frameIndex(10) });

    act(() => transport().play());
    now = 5000;
    raf.tick();
    now = 5100; // Three frames later at 30 fps.
    raf.tick();

    expect(transport().playing).toBe(true);
    expect(transport().frame).toBeGreaterThan(10);
    expect(transport().frame).toBeLessThan(30);
  });

  it('ignores a loop point at or past the end, which would never advance', () => {
    const raf = useFakeRaf();
    const transport = mount({ endFrame: 30, loopFrom: frameIndex(30) });

    act(() => transport().play());
    now = 5000;
    raf.tick();

    expect(transport().playing).toBe(false);
  });

  it('restarts from the loop point when play is pressed at the end', () => {
    // With a range marked, "play again" means the range rather than the top of the sequence.
    const transport = mount({ endFrame: 30, loopFrom: frameIndex(10) });

    act(() => transport().seek(frameIndex(30)));
    act(() => transport().play());

    expect(transport().frame).toBe(10);
  });
});
