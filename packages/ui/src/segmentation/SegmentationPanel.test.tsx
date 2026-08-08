// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipId, err, frameIndex, ok, spanFromBounds } from '@nos/core';
import type { MaskPrompt, MaskSession } from '@nos/masks';
import { addPrompt, applyEvent, beginRun, beginSession, emptyTrack, maskTrackId } from '@nos/masks';
import { MaskPointOverlay, PropagationBar, SegmentationPanel } from './SegmentationPanel.js';

afterEach(cleanup);

const range = spanFromBounds(frameIndex(0), frameIndex(100));
const track = () => emptyTrack(maskTrackId('m1'), clipId('c1'), range);
const base = (): MaskSession => beginSession(track(), frameIndex(10));

const point = (frame: number, include = true, x = 0.5): MaskPrompt => ({
  kind: 'point',
  frame: frameIndex(frame),
  x,
  y: 0.5,
  include,
});

const mask = (frame: number) => ({ frame: frameIndex(frame), width: 2, height: 2, counts: [0, 4] });

const withPoint = () => addPrompt(base(), point(10));

/**
 * jsdom reports a zero-sized box for everything, and the overlay refuses to place a point in one —
 * dividing by it would put every click at Infinity. Tests that click therefore state the box.
 */
function sized(element: HTMLElement, width: number, height: number): HTMLElement {
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

const renderPanel = (overrides: Partial<Parameters<typeof SegmentationPanel>[0]> = {}) =>
  render(<SegmentationPanel session={base()} {...overrides} />);

describe('rendering', () => {
  it('is a labelled panel', () => {
    renderPanel();
    expect(screen.getByRole('region', { name: 'Segmentation' })).toBeDefined();
  });

  it('says what to do first', () => {
    renderPanel();
    expect(screen.getAllByText(/click the object/).length).toBeGreaterThan(0);
  });

  it('mentions the modifier for a negative click, since it is not discoverable', () => {
    // "This, but not that" is what separates a person from the wall behind them; a user who never
    // finds alt-click cannot make the common selection at all.
    renderPanel();
    expect(screen.getByText(/alt-click to exclude/)).toBeDefined();
  });

  it('lists the prompts', () => {
    renderPanel({ session: addPrompt(withPoint(), point(40, false)) });
    const prompts = within(screen.getByRole('list', { name: 'Prompts' }));
    expect(prompts.getAllByRole('listitem')).toHaveLength(2);
  });

  it('distinguishes an excluding prompt', () => {
    // Named rather than only coloured: a red dash conveys nothing to a screen reader, and which
    // prompts exclude is the whole content of this list.
    renderPanel({ session: addPrompt(base(), point(10, false)) });
    expect(screen.getByRole('img', { name: 'exclude' })).toBeDefined();
  });
});

describe('availability', () => {
  it('greys the panel with a concrete reason rather than hiding it', () => {
    // SAM 2 is an optional install; a segmentation panel that silently vanished would be blamed on
    // the application.
    renderPanel({
      capabilities: { available: false, propagates: false, detail: 'the sam2 package is not installed' },
    });
    expect(screen.getByText('the sam2 package is not installed')).toBeDefined();
    expect(screen.getByText('unavailable')).toBeDefined();
  });

  it('disables running while unavailable', () => {
    renderPanel({
      session: withPoint(),
      capabilities: { available: false, propagates: false, detail: 'no model' },
    });
    expect(screen.getByRole('button', { name: 'Segment' }).hasAttribute('disabled')).toBe(true);
  });

  it('cannot run before anything is clicked', () => {
    renderPanel();
    const run = screen.getByRole('button', { name: 'Segment' });
    expect(run.hasAttribute('disabled')).toBe(true);
    expect(run.getAttribute('title')).toContain('click the object');
  });

  it('runs once a prompt exists', () => {
    renderPanel({ session: withPoint(), capabilities: { available: true, propagates: true } });
    expect(screen.getByRole('button', { name: 'Segment' }).hasAttribute('disabled')).toBe(false);
  });

  it('offers a re-run rather than a first run once masks exist', () => {
    const withFrames = applyEvent(beginRun(withPoint()), { kind: 'frame', mask: mask(10) });
    renderPanel({ session: withFrames });
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeDefined();
  });

  it('only offers cancel while a run is in flight', () => {
    renderPanel({ session: withPoint() });
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);

    cleanup();
    renderPanel({ session: beginRun(withPoint()) });
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false);
  });

  it('says cancelling keeps what was masked', () => {
    renderPanel({ session: beginRun(withPoint()) });
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('title')).toContain('keeping');
  });
});

describe('status', () => {
  it('shows progress while running', () => {
    const running = applyEvent(beginRun(withPoint()), { kind: 'progress', progress: { fraction: 0.25 } });
    renderPanel({ session: running });
    expect(screen.getByText('segmenting 25%')).toBeDefined();
  });

  it('shows the failure reason', () => {
    const failed = applyEvent(beginRun(withPoint()), {
      kind: 'done',
      result: err({ kind: 'failed', detail: 'CUDA out of memory' }),
    });
    renderPanel({ session: failed });
    expect(screen.getByText('CUDA out of memory')).toBeDefined();
  });

  it('counts the masked frames when a run finished', () => {
    const done = applyEvent(applyEvent(beginRun(withPoint()), { kind: 'frame', mask: mask(10) }), {
      kind: 'done',
      result: ok({ frames: 1, width: 2, height: 2 }),
    });
    renderPanel({ session: done });
    expect(screen.getByText('1 frames masked')).toBeDefined();
  });
});

describe('interaction', () => {
  it('reports a run', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel({ session: withPoint(), onRun });
    await user.click(screen.getByRole('button', { name: 'Segment' }));
    expect(onRun).toHaveBeenCalled();
  });

  it('reports a cancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderPanel({ session: beginRun(withPoint()), onCancel });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('removes a prompt by index', async () => {
    const user = userEvent.setup();
    const onRemovePrompt = vi.fn();
    renderPanel({ session: addPrompt(withPoint(), point(40)), onRemovePrompt });

    const rows = within(screen.getByRole('list', { name: 'Prompts' })).getAllByRole('listitem');
    await user.click(within(rows[1]!).getByRole('button', { name: /^Remove prompt/ }));
    expect(onRemovePrompt).toHaveBeenCalledWith(1);
  });

  it('seeks to the frame a prompt was placed on', async () => {
    // A prompt made twenty seconds earlier is otherwise unreachable: visible, and impossible to get
    // back to in order to judge it.
    const user = userEvent.setup();
    const onSeek = vi.fn();
    renderPanel({ session: addPrompt(base(), point(42)), onSeek });

    await user.click(screen.getByRole('button', { name: 'frame 42' }));
    expect(onSeek).toHaveBeenCalledWith(42);
  });
});

describe('the propagation bar', () => {
  it('shows the range in frames', () => {
    render(<PropagationBar session={base()} />);
    expect(screen.getByText('0–100')).toBeDefined();
  });

  it('reports a narrowed start', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PropagationBar session={base()} onChange={onChange} />);

    // Pasted rather than typed: the field is controlled by the session, and a spy never feeds the
    // value back, so typing would assert on a half-entered number.
    await user.clear(screen.getByLabelText('From'));
    await user.click(screen.getByLabelText('From'));
    await user.paste('20');
    expect(onChange).toHaveBeenLastCalledWith(spanFromBounds(frameIndex(20), frameIndex(100)));
  });

  it('draws a band per contiguous run of masked frames', () => {
    // The fill growing as work lands is what makes a long propagation bearable — a stalled run is
    // visible immediately rather than after a timeout.
    const covered = [10, 11, 12, 40].reduce(
      (session, frame) => applyEvent(session, { kind: 'frame', mask: mask(frame) }),
      beginRun(withPoint()),
    );
    render(<PropagationBar session={covered} />);
    expect(screen.getAllByTestId('covered-span')).toHaveLength(2);
  });

  it('draws nothing before the first mask arrives', () => {
    render(<PropagationBar session={base()} />);
    expect(screen.queryAllByTestId('covered-span')).toHaveLength(0);
  });
});

describe('the click overlay', () => {
  it('normalizes a click against the element, not the screen', async () => {
    // A pixel coordinate would put every mask somewhere else the moment the window is resized, and
    // would be wrong on a proxy at a different resolution.
    const user = userEvent.setup();
    const onAddPrompt = vi.fn();
    const { container } = render(
      <MaskPointOverlay session={base()} width={200} height={100} onAddPrompt={onAddPrompt} />,
    );

    const overlay = sized(container.firstElementChild as HTMLElement, 200, 100);

    await user.pointer({ target: overlay, coords: { clientX: 50, clientY: 25 } });
    await user.click(overlay);

    expect(onAddPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'point', x: 0.25, y: 0.25, frame: 10, include: true }),
    );
  });

  it('places the click on the frame the user is looking at', async () => {
    const user = userEvent.setup();
    const onAddPrompt = vi.fn();
    const { container } = render(
      <MaskPointOverlay
        session={beginSession(track(), frameIndex(77))}
        width={100}
        height={100}
        onAddPrompt={onAddPrompt}
      />,
    );

    await user.click(sized(container.firstElementChild as HTMLElement, 100, 100));
    expect(onAddPrompt).toHaveBeenCalledWith(expect.objectContaining({ frame: 77 }));
  });

  it('excludes on alt-click, as a modifier rather than a mode', async () => {
    // The two kinds of click alternate constantly while refining; a mode toggle turns every
    // correction into two actions.
    const user = userEvent.setup();
    const onAddPrompt = vi.fn();
    const { container } = render(
      <MaskPointOverlay session={base()} width={100} height={100} onAddPrompt={onAddPrompt} />,
    );

    await user.keyboard('{Alt>}');
    await user.click(sized(container.firstElementChild as HTMLElement, 100, 100));
    await user.keyboard('{/Alt}');

    expect(onAddPrompt).toHaveBeenCalledWith(expect.objectContaining({ include: false }));
  });

  it('does not place a point when the box has no size yet', async () => {
    // Dividing by a zero-sized box during layout would place every point at Infinity.
    const user = userEvent.setup();
    const onAddPrompt = vi.fn();
    const { container } = render(
      <MaskPointOverlay session={base()} width={0} height={0} onAddPrompt={onAddPrompt} />,
    );

    await user.click(sized(container.firstElementChild as HTMLElement, 0, 0));
    expect(onAddPrompt).not.toHaveBeenCalled();
  });

  it('shows only the points placed on the current frame', () => {
    const session = addPrompt(addPrompt(base(), point(10)), point(40));
    render(<MaskPointOverlay session={session} width={100} height={100} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('names each point by what it does', () => {
    render(<MaskPointOverlay session={addPrompt(base(), point(10, false))} width={100} height={100} />);
    expect(screen.getByRole('button', { name: 'Exclude point at frame 10' })).toBeDefined();
  });

  it('removes a point without also placing a new one under the cursor', async () => {
    // Without stopping propagation, deleting a point would immediately add one where it was.
    const user = userEvent.setup();
    const onAddPrompt = vi.fn();
    const onRemovePrompt = vi.fn();
    render(
      <MaskPointOverlay
        session={withPoint()}
        width={100}
        height={100}
        onAddPrompt={onAddPrompt}
        onRemovePrompt={onRemovePrompt}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Include point/ }));
    expect(onRemovePrompt).toHaveBeenCalledWith(0);
    expect(onAddPrompt).not.toHaveBeenCalled();
  });

  it('ignores clicks while disabled', async () => {
    const user = userEvent.setup();
    const onAddPrompt = vi.fn();
    const { container } = render(
      <MaskPointOverlay session={base()} width={100} height={100} disabled onAddPrompt={onAddPrompt} />,
    );

    await user.click(sized(container.firstElementChild as HTMLElement, 100, 100));
    expect(onAddPrompt).not.toHaveBeenCalled();
  });
});
