// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BEZIER, evaluateBezier } from '@nos/core';
import { BezierEditor } from './BezierEditor.js';

/**
 * Dragging the curve.
 *
 * Two properties matter and both are about *which* coordinate is free. Time must run forwards, so a
 * handle dragged past either end clamps; value must not, because overshoot is one of the two reasons
 * to want a custom curve at all. A test that only checked "it reports something" would pass with the
 * axes swapped.
 */

afterEach(cleanup);

/** The editor with a stated box, since jsdom gives every element a zero-sized one. */
function mount(points = DEFAULT_BEZIER) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const { container } = render(<BezierEditor points={points} onChange={onChange} onCommit={onCommit} />);

  const surface = container.querySelector('svg') as SVGSVGElement;
  // 200 px wide, 320 tall: the viewBox is 100 across and 160 down (the unit square plus a 30-unit
  // margin at each end), so one curve unit is two pixels in both axes.
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 200, bottom: 320, width: 200, height: 320, x: 0, y: 0 }) as DOMRect;

  const grab = (
    index: 1 | 2,
    to: { x: number; y: number },
    through: readonly { x: number; y: number }[] = [],
    options: { readonly release?: boolean } = {},
  ): void => {
    const handle = container.querySelector(`[data-bezier-handle="${index}"]`) as SVGCircleElement;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    for (const point of [...through, to]) {
      act(() => {
        window.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, clientX: point.x, clientY: point.y }),
        );
      });
    }
    if (options.release !== false) {
      act(() => {
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      });
    }
  };

  return { container, onChange, onCommit, grab };
}

describe('what it draws', () => {
  it('draws the curve and both handles', () => {
    const { container } = mount();
    expect(container.querySelector('path')).not.toBeNull();
    expect(container.querySelector('[data-bezier-handle="1"]')).not.toBeNull();
    expect(container.querySelector('[data-bezier-handle="2"]')).not.toBeNull();
  });

  it('draws the curve through the evaluator the renderer uses', () => {
    // SVG's own cubic is parameterized by its internal position; the evaluator solves for time first.
    // The two differ visibly wherever the control points are uneven, and a preview that flatters the
    // curve is worse than none.
    const points = { x1: 0.9, y1: 0, x2: 1, y2: 0.1 };
    const { container } = mount(points);
    const path = container.querySelector('path')!.getAttribute('d')!;

    // Halfway across, the drawn height must match what the evaluator says the value is there.
    const commands = path.split(/(?=[ML])/).map((step) => step.slice(1).split(' ').map(Number));
    const halfway = commands.find(([x]) => Math.abs((x ?? 0) - 50) < 0.01)!;
    expect(halfway[1]).toBeCloseTo((1 - evaluateBezier(points, 0.5)) * 100, 1);
  });

  it('names each handle’s position, since a curve has no single number to read', () => {
    const { container } = mount({ x1: 0.25, y1: 0.75, x2: 0.5, y2: 0.5 });
    expect(container.querySelector('[data-bezier-handle="1"]')?.getAttribute('aria-label')).toBe(
      'control point 1 at 0.25, 0.75',
    );
  });
});

describe('dragging a handle', () => {
  it('commits once for the whole gesture, whatever it passed through', () => {
    /*
     * One drag is one history entry — the rule every other gesture here follows, and the one this
     * component broke on the way in: both callers were wired to the live channel, so dragging a handle
     * across the box wrote a commit per pointer move and buried whatever came before it under forty
     * entries of "set fade curve".
     */
    const { onChange, onCommit, grab } = mount();
    // 100 px across of 200 is x = 0.5; 160 px down of 320 is the middle of the box, y = 0.5.
    grab(1, { x: 100, y: 160 }, [{ x: 40, y: 60 }, { x: 70, y: 100 }]);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls.at(-1)![0]).toMatchObject({ x1: 0.5, y1: 0.5 });
    // The live channel still reports every position, for a caller that can show one without
    // recording it — it is simply not what a caller reaches for first.
    expect(onChange.mock.calls.length).toBeGreaterThan(1);
  });

  it('follows the pointer while the drag is in flight, without the document changing', () => {
    // The handle is drawn from a draft held in the component: without one it would sit still until
    // release, because the only thing that moves it is a prop the caller has not written yet.
    const { container, grab } = mount();
    grab(1, { x: 100, y: 160 }, [{ x: 40, y: 60 }], { release: false });

    const handle = container.querySelector('[data-bezier-handle="1"]');
    expect(handle?.getAttribute('aria-label')).toBe('control point 1 at 0.50, 0.50');
  });

  it('lets the committed curve take over again once the gesture ends', () => {
    // A draft that outlived its drag would show a curve the project does not have.
    const { container, grab } = mount();
    grab(1, { x: 100, y: 160 });
    const handle = container.querySelector('[data-bezier-handle="1"]');
    // Back to the unchanged prop, because the caller in this test never writes one.
    expect(handle?.getAttribute('aria-label')).toBe('control point 1 at 0.33, 0.33');
  });

  it('moves only the handle that was grabbed', () => {
    const { onChange, grab } = mount();
    grab(2, { x: 100, y: 160 });
    const reported = onChange.mock.calls.at(-1)![0];
    expect(reported).toMatchObject({ x1: DEFAULT_BEZIER.x1, y1: DEFAULT_BEZIER.y1, x2: 0.5, y2: 0.5 });
  });

  it('clamps time, because a curve running backwards has no meaning', () => {
    const { onChange, grab } = mount();
    grab(1, { x: -400, y: 160 });
    expect(onChange.mock.calls.at(-1)![0].x1).toBe(0);

    grab(1, { x: 900, y: 160 });
    expect(onChange.mock.calls.at(-1)![0].x1).toBe(1);
  });

  it('lets the value go past the ends, which is what an overshooting curve is', () => {
    const { onChange, grab } = mount();
    // 20 px down of 320 is above the unit square, inside the margin the editor keeps for exactly this.
    grab(2, { x: 100, y: 20 });
    expect(onChange.mock.calls.at(-1)![0].y2).toBeGreaterThan(1);
  });
});
