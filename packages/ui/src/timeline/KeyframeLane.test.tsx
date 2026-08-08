// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Easing, type Keyframe, FRAME_RATES, frameIndex, keyframeId } from '@nos/core';
import { EASING_CYCLE, KEYFRAME_LANE_HEIGHT, KeyframeLane, laneLabel, nextEasing } from './KeyframeLane.js';
import { createViewport } from './viewport.js';

afterEach(cleanup);

function kf(id: string, frame: number, value: number, ease: Easing = 'linear'): Keyframe {
  return { id: keyframeId(id), frame: frameIndex(frame), value, ease };
}

const viewport = createViewport({
  framesPerPixel: 1,
  scrollFrame: frameIndex(0),
  widthPx: 1000,
  frameRate: FRAME_RATES.WEB_30,
});

const keyframes = [kf('k1', 0, 0, 'ease-out'), kf('k2', 100, 0.5, 'hold'), kf('k3', 200, 1)];

function renderLane(overrides: Partial<Parameters<typeof KeyframeLane>[0]> = {}) {
  return render(
    <KeyframeLane
      label="film_grain · amount"
      keyframes={keyframes}
      clipStart={frameIndex(0)}
      viewport={viewport}
      playhead={frameIndex(50)}
      {...overrides}
    />,
  );
}

describe('rendering', () => {
  it('draws a marker per keyframe', () => {
    renderLane();
    expect(document.querySelectorAll('[data-keyframe]')).toHaveLength(3);
  });

  it('groups the lane under its parameter name', () => {
    renderLane();
    expect(screen.getByRole('group', { name: 'film_grain · amount keyframes' })).toBeDefined();
  });

  it('positions markers from the viewport, offset by the clip start', () => {
    // Keyframe positions are clip-relative, so a clip at frame 500 puts its frame-0 keyframe at 500.
    renderLane({ clipStart: frameIndex(500) });
    const first = document.querySelector('[data-keyframe="k1"]') as HTMLElement;
    // 1 f/px, scroll 0: absolute frame 500 sits at 500 px, less half the 11 px marker.
    expect(Math.round(Number.parseFloat(first.style.left))).toBe(495);
  });

  it('skips off-screen markers, keeping the DOM proportional to what is visible', () => {
    renderLane({ keyframes: [kf('k1', 0, 0), kf('far', 90_000, 1)] });
    expect(document.querySelector('[data-keyframe="far"]')).toBeNull();
    expect(document.querySelector('[data-keyframe="k1"]')).not.toBeNull();
  });

  it('uses the lane height from the mockups', () => {
    renderLane();
    const lane = screen.getByRole('group', { name: /keyframes/ });
    expect(lane.style.height).toBe(`${KEYFRAME_LANE_HEIGHT}px`);
  });

  it('renders nothing but the baseline for an empty parameter', () => {
    renderLane({ keyframes: [] });
    expect(document.querySelectorAll('[data-keyframe]')).toHaveLength(0);
  });
});

describe('easing badges', () => {
  it('shows a badge per segment-governing keyframe', () => {
    renderLane();
    expect(screen.getByRole('button', { name: /Easing after frame 0: ease-out/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Easing after frame 100: hold/ })).toBeDefined();
  });

  it('omits a badge on the last keyframe, whose easing governs nothing', () => {
    // Its easing has no segment to apply to, so a badge there would be misleading.
    renderLane();
    expect(screen.queryByRole('button', { name: /Easing after frame 200/ })).toBeNull();
  });

  it('cycles easing when a badge is activated', async () => {
    const user = userEvent.setup();
    const onCycleEasing = vi.fn();
    renderLane({ onCycleEasing });
    await user.click(screen.getByRole('button', { name: /Easing after frame 0/ }));
    expect(onCycleEasing).toHaveBeenCalledWith('k1');
  });

  it('shows the value alongside the easing on the selected marker', () => {
    renderLane({ selected: keyframeId('k1') });
    expect(screen.getByRole('button', { name: /Easing after frame 0/ }).textContent).toBe('0.00 · ease-out');
  });
});

describe('value readout', () => {
  it('shows the evaluated value under the playhead', () => {
    // Halfway between 0 and 0.5 on a linear... the first segment eases out, so at frame 50 the value is
    // past the linear midpoint.
    renderLane({ playhead: frameIndex(50) });
    const text = screen.getByRole('group', { name: /keyframes/ }).textContent ?? '';
    expect(text).toMatch(/0\.\d\d/);
  });

  it('holds the value across a hold segment', () => {
    renderLane({
      keyframes: [kf('k1', 0, 0.25, 'hold'), kf('k2', 100, 1)],
      playhead: frameIndex(90),
    });
    expect(screen.getByRole('group', { name: /keyframes/ }).textContent).toContain('0.25');
  });

  it('shows nothing when the parameter has no keyframes', () => {
    renderLane({ keyframes: [] });
    expect(screen.getByRole('group', { name: /keyframes/ }).textContent).toBe('');
  });
});

describe('keyboard operation', () => {
  it('exposes each marker as a slider with its value and easing', () => {
    renderLane();
    const marker = screen.getByRole('slider', {
      name: 'film_grain · amount keyframe at frame 100',
    });
    expect(marker.getAttribute('aria-valuetext')).toBe('0.50, hold');
  });

  it('nudges a keyframe with the arrow keys', async () => {
    const user = userEvent.setup();
    const onDragKeyframe = vi.fn();
    renderLane({ onDragKeyframe });

    screen.getByRole('slider', { name: /frame 100/ }).focus();
    await user.keyboard('{ArrowRight}');

    expect(onDragKeyframe).toHaveBeenCalledWith('k2', 101);
  });

  it('nudges by ten frames with shift held', async () => {
    const user = userEvent.setup();
    const onDragKeyframe = vi.fn();
    renderLane({ onDragKeyframe });

    screen.getByRole('slider', { name: /frame 100/ }).focus();
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');

    expect(onDragKeyframe).toHaveBeenCalledWith('k2', 90);
  });

  it('cycles easing with Enter', async () => {
    const user = userEvent.setup();
    const onCycleEasing = vi.fn();
    renderLane({ onCycleEasing });

    screen.getByRole('slider', { name: /frame 0$/ }).focus();
    await user.keyboard('{Enter}');

    expect(onCycleEasing).toHaveBeenCalledWith('k1');
  });

  it('deletes a keyframe with Delete', async () => {
    const user = userEvent.setup();
    const onRemoveKeyframe = vi.fn();
    renderLane({ onRemoveKeyframe });

    screen.getByRole('slider', { name: /frame 200/ }).focus();
    await user.keyboard('{Delete}');

    expect(onRemoveKeyframe).toHaveBeenCalledWith('k3');
  });

  it('accounts for the clip start when nudging', () => {
    const onDragKeyframe = vi.fn();
    renderLane({ clipStart: frameIndex(500), onDragKeyframe });

    const marker = screen.getByRole('slider', { name: /frame 600/ });
    marker.focus();
    marker.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    // Reported in absolute frames, since that is what an edit operation takes.
    expect(onDragKeyframe).toHaveBeenCalledWith('k2', 601);
  });
});

describe('adding keyframes', () => {
  it('adds at the double-clicked frame', async () => {
    const user = userEvent.setup();
    const onAddKeyframe = vi.fn();
    renderLane({ onAddKeyframe });

    await user.dblClick(screen.getByRole('group', { name: /keyframes/ }));

    expect(onAddKeyframe).toHaveBeenCalled();
    // jsdom reports a zero-origin rect, so the resolved frame is the scroll position.
    expect(onAddKeyframe.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);
  });
});

describe('drag lifecycle', () => {
  it('starts a drag even where pointer capture is unavailable', () => {
    // Capture is an enhancement, not a requirement: a marker that cannot be dragged at all is far worse
    // than one that loses events when the pointer leaves the window.
    const onDragStart = vi.fn();
    renderLane({ onDragStart });
    const marker = document.querySelector('[data-keyframe="k1"]')!;
    expect(() => marker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))).not.toThrow();
    expect(onDragStart).toHaveBeenCalledWith('k1');
  });

  it('reports a drag start so the caller can open one undo gesture', () => {
    const onDragStart = vi.fn();
    const onSelectKeyframe = vi.fn();
    renderLane({ onDragStart, onSelectKeyframe });

    const marker = document.querySelector('[data-keyframe="k2"]')!;
    marker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    expect(onDragStart).toHaveBeenCalledWith('k2');
    // Selecting on grab means the inspector follows what is being dragged.
    expect(onSelectKeyframe).toHaveBeenCalledWith('k2');
  });

  it('ends the gesture on pointercancel, not only on pointerup', () => {
    // Without this an interrupted drag leaves the caller's undo gesture open, silently merging every
    // later edit into it.
    const onDragEnd = vi.fn();
    renderLane({ onDragEnd });

    const marker = document.querySelector('[data-keyframe="k2"]') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    marker.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));

    expect(onDragEnd).toHaveBeenCalled();
  });
});

describe('nextEasing', () => {
  it('cycles through every easing and returns to the start', () => {
    let current: Easing = 'linear';
    const seen: Easing[] = [current];
    for (let i = 0; i < EASING_CYCLE.length - 1; i += 1) {
      current = nextEasing(current);
      seen.push(current);
    }
    expect(seen).toEqual([...EASING_CYCLE]);
    expect(nextEasing(current)).toBe('linear');
  });

  it('covers exactly the five easings the spec defines for v1', () => {
    expect([...EASING_CYCLE]).toEqual(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']);
  });

  it('restarts at linear for an unrecognized easing', () => {
    // How a project written by a build with Bezier support degrades.
    expect(nextEasing('bezier' as Easing)).toBe('linear');
  });
});

describe('laneLabel', () => {
  it('joins the effect and parameter names the way the stack does', () => {
    expect(laneLabel('film_grain', 'amount')).toBe('film_grain · amount');
  });
});
