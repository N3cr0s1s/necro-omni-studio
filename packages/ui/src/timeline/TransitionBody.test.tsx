// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Transition, effectId, effectInstanceId, clipId, frameIndex, spanFromBounds } from '@nos/core';
import { TransitionBody } from './TransitionBody.js';

/**
 * A transition drawn across the cut it joins.
 *
 * It had none: one could be created from the clip inspector, was honoured by the compositor, and
 * appeared nowhere on the timeline.
 */

afterEach(cleanup);

const transition = (): Transition => ({
  id: effectInstanceId('t1'),
  effect: effectId('cross_dissolve'),
  span: spanFromBounds(frameIndex(90), frameIndex(120)),
  from: clipId('a'),
  to: clipId('b'),
  params: {},
});

const geometry = { leftPx: 90, widthPx: 30, clippedStart: false, clippedEnd: false };

describe('what it says', () => {
  it('names the effect and how long the overlap is', () => {
    // The length is the point: a transition *is* the frames both clips play, and a band with no
    // number leaves that readable only by eye.
    render(
      <TransitionBody
        transition={transition()}
        geometry={geometry}
        label="Cross dissolve"
        selected={false}
        onSelect={() => undefined}
      />,
    );
    expect(screen.queryByLabelText('Cross dissolve transition, 30 frames')).not.toBeNull();
  });

  it('draws across exactly the frames the clips share', () => {
    render(
      <TransitionBody
        transition={transition()}
        geometry={geometry}
        label="Cross dissolve"
        selected={false}
        onSelect={() => undefined}
      />,
    );
    const band = screen.getByRole('button');
    expect(band.style.left).toBe('90px');
    expect(band.style.width).toBe('30px');
  });
});

describe('selecting one', () => {
  it('reports the selection on a press', async () => {
    const onSelect = vi.fn();
    render(
      <TransitionBody
        transition={transition()}
        geometry={geometry}
        label="Cross dissolve"
        selected={false}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith('t1');
  });

  it('says when it is the selected one', () => {
    render(
      <TransitionBody
        transition={transition()}
        geometry={geometry}
        label="Cross dissolve"
        selected
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('removing one', () => {
  it('goes on Delete, which is where the press left the focus', async () => {
    const onRemove = vi.fn();
    render(
      <TransitionBody
        transition={transition()}
        geometry={geometry}
        label="Cross dissolve"
        selected={false}
        onSelect={() => undefined}
        onRemove={onRemove}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    await userEvent.keyboard('{Delete}');
    expect(onRemove).toHaveBeenCalledWith('t1');
  });

  it('is not offered when the caller has no way to do it', async () => {
    render(
      <TransitionBody
        transition={transition()}
        geometry={geometry}
        label="Cross dissolve"
        selected={false}
        onSelect={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    await userEvent.keyboard('{Delete}');
    // Nothing to assert but the absence of a throw: an optional handler that is missing must not be
    // called.
    expect(screen.queryByRole('button')).not.toBeNull();
  });
});

describe('the resize handle', () => {
  it('is drawn only when the caller can act on it', () => {
    const { rerender } = render(
      <TransitionBody
        transition={transition()}
        geometry={geometry}
        label="Cross dissolve"
        selected={false}
        onSelect={() => undefined}
      />,
    );
    expect(document.querySelector('[data-transition-resize]')).toBeNull();

    rerender(
      <TransitionBody
        transition={transition()}
        geometry={geometry}
        label="Cross dissolve"
        selected={false}
        onSelect={() => undefined}
        onResize={() => undefined}
      />,
    );
    expect(document.querySelector('[data-transition-resize]')).not.toBeNull();
  });
});
