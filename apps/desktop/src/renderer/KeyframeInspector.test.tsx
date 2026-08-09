// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_RATES, frameIndex, keyframeId } from '@nos/core';
import { KeyframeInspector } from './KeyframeInspector.js';
import type { SelectedKeyframe } from './KeyframeLanes.js';

/**
 * The selected marker in the right column.
 *
 * The property worth guarding hardest is the **frame**: keyframes are stored clip-relative, and every
 * other number in this column is a timeline position. A field that showed 12 while the ruler said 312
 * would be a conversion the user has to do in their head on every read and every write.
 */

afterEach(cleanup);

const selected = (overrides: Partial<SelectedKeyframe> = {}): SelectedKeyframe => ({
  id: keyframeId('k1'),
  label: 'transform · opacity',
  keyframe: { id: keyframeId('k1'), frame: frameIndex(12), value: 0.4, ease: 'ease-out' },
  absoluteFrame: frameIndex(312),
  last: false,
  ...overrides,
});

function mount(overrides: Partial<SelectedKeyframe> = {}) {
  const onEdit = vi.fn();
  const onRemove = vi.fn();
  render(
    <KeyframeInspector
      selected={selected(overrides)}
      frameRate={FRAME_RATES.WEB_30}
      onEdit={onEdit}
      onRemove={onRemove}
    />,
  );
  return { onEdit, onRemove };
}

describe('what it shows', () => {
  it('names the parameter the marker animates', () => {
    mount();
    expect(screen.getByText('transform · opacity')).toBeDefined();
  });

  it('shows the frame as a timeline position, not as an offset into the clip', () => {
    mount();
    expect((screen.getByLabelText('keyframe frame') as HTMLInputElement).value).toBe('312');
    expect(screen.getByText('00:00:10:12')).toBeDefined();
  });

  it('shows the value and marks the current easing', () => {
    mount();
    expect((screen.getByLabelText('keyframe value') as HTMLInputElement).value).toBe('0.4');
    expect(screen.getByRole('radio', { name: 'ease-out' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'linear' }).getAttribute('aria-checked')).toBe('false');
  });

  it('says why the last marker has no easing rather than offering dead buttons', () => {
    // A row of controls that do nothing teaches the user that easing is unreliable; the sentence says
    // it is the last marker that is special.
    mount({ last: true });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByText(/governs nothing/)).toBeDefined();
  });
});

describe('what it changes', () => {
  it('reports a typed frame as a timeline position, for the caller to rebase', () => {
    const { onEdit } = mount();
    return userEvent
      .clear(screen.getByLabelText('keyframe frame'))
      .then(() => userEvent.type(screen.getByLabelText('keyframe frame'), '340{Enter}'))
      .then(() => {
        expect(onEdit).toHaveBeenCalledWith({ frame: 340 });
      });
  });

  it('reports a typed value', async () => {
    const { onEdit } = mount();
    const field = screen.getByLabelText('keyframe value');
    await userEvent.clear(field);
    await userEvent.type(field, '0.75{Enter}');
    expect(onEdit).toHaveBeenCalledWith({ value: 0.75 });
  });

  it('reports an easing chosen directly, rather than making the user cycle to it', async () => {
    // The lane cycles, because a badge has room for one word. Five markers away from the easing you
    // want is four presses that each change the document.
    const { onEdit } = mount();
    await userEvent.click(screen.getByRole('radio', { name: 'hold' }));
    expect(onEdit).toHaveBeenCalledWith({ ease: 'hold' });
  });

  it('commits nothing when a field is re-entered unchanged', async () => {
    const { onEdit } = mount();
    const field = screen.getByLabelText('keyframe value');
    await userEvent.clear(field);
    await userEvent.type(field, '0.4{Enter}');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('removes the marker', async () => {
    const { onRemove } = mount();
    await userEvent.click(screen.getByLabelText('Remove keyframe'));
    expect(onRemove).toHaveBeenCalled();
  });
});
