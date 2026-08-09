// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Easing, type Keyframe, FRAME_RATES, frameIndex, keyframeId } from '@nos/core';
import {
  EASING_CYCLE,
  KEYFRAME_LANE_HEIGHT,
  KeyframeLane,
  laneLabel,
  laneValueRange,
  nextEasing,
} from './KeyframeLane.js';
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

/**
 * The value field.
 *
 * The absence of this was not a missing control but a missing *capability*: a parameter's slider is
 * disabled once it is keyframed, so between the two there was nowhere at all to give a marker a
 * number, and an animation could only hold whatever value was current when it was made.
 */
describe('editing a value', () => {
  const selected = { selected: keyframeId('k2'), onChangeValue: vi.fn() };

  it('offers a field for the selected marker, in place of the readout', () => {
    renderLane(selected);
    expect(screen.getByLabelText('Value at frame 100')).toHaveProperty('value', '0.5');
  });

  it('leaves the readout alone when nothing in this lane is selected', () => {
    // Selection is per clip, so a marker on another parameter's lane must not open a field here.
    renderLane({ selected: keyframeId('somewhere-else'), onChangeValue: vi.fn() });
    expect(screen.queryByLabelText(/^Value at frame/)).toBeNull();
  });

  it('reports the new value on Enter', async () => {
    const onChangeValue = vi.fn();
    renderLane({ selected: keyframeId('k2'), onChangeValue });

    const field = screen.getByLabelText('Value at frame 100');
    await userEvent.clear(field);
    await userEvent.type(field, '0.8{Enter}');

    expect(onChangeValue).toHaveBeenCalledWith('k2', 0.8);
  });

  it('reports it on blur too, because clicking away is a decision', async () => {
    const onChangeValue = vi.fn();
    renderLane({ selected: keyframeId('k2'), onChangeValue });

    const field = screen.getByLabelText('Value at frame 100');
    await userEvent.clear(field);
    await userEvent.type(field, '-2');
    await userEvent.tab();

    expect(onChangeValue).toHaveBeenCalledWith('k2', -2);
  });

  it('puts the marker back on Escape', async () => {
    const onChangeValue = vi.fn();
    renderLane({ selected: keyframeId('k2'), onChangeValue });

    const field = screen.getByLabelText('Value at frame 100');
    await userEvent.clear(field);
    await userEvent.type(field, '9{Escape}');

    expect(field).toHaveProperty('value', '0.5');
    expect(onChangeValue).not.toHaveBeenCalled();
  });

  it('does not report an empty field, which is what clearing it to type looks like', async () => {
    // A field that wrote on every keystroke could not be typed in at all: clearing it to enter `0.5`
    // sends an empty string first, and `-` on its own is not a number.
    const onChangeValue = vi.fn();
    renderLane({ selected: keyframeId('k2'), onChangeValue });

    const field = screen.getByLabelText('Value at frame 100');
    await userEvent.clear(field);
    await userEvent.tab();

    expect(onChangeValue).not.toHaveBeenCalled();
    expect(field).toHaveProperty('value', '0.5');
  });

  it('keeps the timeline out of it while the field has focus', async () => {
    // Delete would otherwise remove the very marker being edited.
    const onRemoveKeyframe = vi.fn();
    renderLane({ selected: keyframeId('k2'), onChangeValue: vi.fn(), onRemoveKeyframe });

    const field = screen.getByLabelText('Value at frame 100');
    field.focus();
    await userEvent.keyboard('{Delete}');

    expect(onRemoveKeyframe).not.toHaveBeenCalled();
  });

  it('follows the marker when it changes underneath, as an undo makes it', () => {
    const { rerender } = renderLane(selected);
    rerender(
      <KeyframeLane
        label="film_grain · amount"
        keyframes={[kf('k1', 0, 0), kf('k2', 100, 0.25), kf('k3', 200, 1)]}
        clipStart={frameIndex(0)}
        viewport={viewport}
        playhead={frameIndex(50)}
        selected={keyframeId('k2')}
        onChangeValue={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Value at frame 100')).toHaveProperty('value', '0.25');
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

    // The value travels with every nudge: a marker has two coordinates and one edit writes both, so
    // a horizontal nudge states the value it is keeping rather than leaving it to a second write.
    expect(onDragKeyframe).toHaveBeenCalledWith('k2', 101, 0.5);
  });

  it('nudges by ten frames with shift held', async () => {
    const user = userEvent.setup();
    const onDragKeyframe = vi.fn();
    renderLane({ onDragKeyframe });

    screen.getByRole('slider', { name: /frame 100/ }).focus();
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');

    expect(onDragKeyframe).toHaveBeenCalledWith('k2', 90, 0.5);
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
    expect(onDragKeyframe).toHaveBeenCalledWith('k2', 601, 0.5);
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

/**
 * The curve, and markers placed at their values.
 *
 * Issue #37 asked for "a grabbable, movable line". A lane that drew every marker on one baseline said
 * nothing about the shape of the animation — the one thing a curve exists to show — and dragging
 * changed only the frame, so a value could be set nowhere but a number field, one marker at a time.
 */
describe('the value curve', () => {
  it('places a marker at its own value rather than on a shared baseline', () => {
    renderLane({ heightPx: 100 });
    const low = document.querySelector('[data-keyframe="k1"]') as HTMLElement;
    const mid = document.querySelector('[data-keyframe="k2"]') as HTMLElement;
    const high = document.querySelector('[data-keyframe="k3"]') as HTMLElement;

    // Values 0, 0.5, 1 — so the tops descend, since a larger value is further up the lane.
    expect(Number.parseFloat(low.style.top)).toBeGreaterThan(Number.parseFloat(mid.style.top));
    expect(Number.parseFloat(mid.style.top)).toBeGreaterThan(Number.parseFloat(high.style.top));
  });

  it('draws the curve through the evaluator, so a hold reads as a step', () => {
    renderLane({ heightPx: 100 });
    const curve = document.querySelector('[data-value-curve] polyline');
    expect(curve).not.toBeNull();

    const points = (curve!.getAttribute('points') ?? '').split(' ').map((pair) => {
      const [x, y] = pair.split(',');
      return { x: Number(x), y: Number(y) };
    });
    // `k2` at frame 100 holds until `k3` at 200, so every sample between them sits at k2's height.
    const held = points.filter((point) => point.x > 110 && point.x < 190);
    expect(new Set(held.map((point) => point.y)).size).toBe(1);
  });

  it('reports both axes from a drag, so one edit writes the marker', () => {
    const onDragKeyframe = vi.fn();
    const { container } = renderLane({ heightPx: 100, onDragKeyframe });
    const marker = document.querySelector('[data-keyframe="k2"]') as HTMLElement;

    // jsdom gives every element a zero box, so the lane has to be told its own.
    const lane = container.querySelector('[data-keyframe-lane]') as HTMLElement;
    lane.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100, x: 0, y: 0 }) as DOMRect;

    marker.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 120, clientY: 20 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

    expect(onDragKeyframe).toHaveBeenCalled();
    const [, frame, value] = onDragKeyframe.mock.calls.at(-1)!;
    expect(frame).toBe(120);
    // Dragged upward, so the value rose past where it was.
    expect(value).toBeGreaterThan(0.5);
  });

  it('nudges the value with the vertical arrows', async () => {
    const user = userEvent.setup();
    const onDragKeyframe = vi.fn();
    renderLane({ onDragKeyframe });

    screen.getByRole('slider', { name: /frame 100/ }).focus();
    await user.keyboard('{ArrowUp}');

    const [, frame, value] = onDragKeyframe.mock.calls.at(-1)!;
    expect(frame).toBe(100);
    expect(value).toBeGreaterThan(0.5);
  });
});

describe('the range a lane draws against', () => {
  it('is the keyframes’ own extent, not a fixed zero to one', () => {
    // A blur radius in pixels or a rotation in degrees would otherwise draw every marker on one edge.
    expect(laneValueRange([kf('a', 0, 90), kf('b', 10, 270)])).toEqual({ min: 90, max: 270 });
  });

  it('opens a span around a flat parameter, which would otherwise be undraggable', () => {
    const range = laneValueRange([kf('a', 0, 1), kf('b', 10, 1)]);
    expect(range.max).toBeGreaterThan(range.min);
    expect(range.min).toBeLessThan(1);
    expect(range.max).toBeGreaterThan(1);
  });

  it('scales that span with the value, so a rotation is not given a ±0.5 lane', () => {
    const range = laneValueRange([kf('a', 0, 180), kf('b', 10, 180)]);
    expect(range.max - range.min).toBeGreaterThan(1);
  });

  it('answers a usable range for no keyframes at all', () => {
    expect(laneValueRange([])).toEqual({ min: 0, max: 1 });
  });
});
