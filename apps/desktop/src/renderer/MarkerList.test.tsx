// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_RATES, type Marker, frameIndex } from '@nos/core';
import { MarkerList } from './MarkerList.js';

afterEach(cleanup);

/**
 * Every marker at once.
 *
 * The ruler draws them, but a ruler shows the stretch of sequence that happens to be on screen, and
 * the only way through them was `Alt`+arrow — one at a time and blind. On a twenty-minute cut the
 * question is "where did I note the thing about the interview", and the answer was to step through
 * every flag until one said so.
 */

const marker = (frame: number, label: string, color?: string): Marker => ({
  frame: frameIndex(frame),
  label,
  ...(color === undefined ? {} : { color }),
});

function mount(markers: readonly Marker[], overrides: Partial<Parameters<typeof MarkerList>[0]> = {}) {
  const onSeek = vi.fn();
  const onEdit = vi.fn();
  const onRemove = vi.fn();
  render(
    <MarkerList
      markers={markers}
      frameRate={FRAME_RATES.WEB_30}
      playhead={frameIndex(0)}
      onSeek={onSeek}
      onEdit={onEdit}
      onRemove={onRemove}
      {...overrides}
    />,
  );
  return { onSeek, onEdit, onRemove };
}

describe('the marker list', () => {
  it('names the way to make one when there are none', () => {
    // An empty state that does not name the way out is a dead end with a label on it.
    mount([]);
    expect(screen.getByText(/Press/).textContent).toContain('M');
  });

  it('shows each marker with the timecode that identifies it', () => {
    // Two markers can share a name; none can share a frame.
    mount([marker(0, 'top'), marker(90, 'interview')]);
    expect(screen.getByRole('button', { name: '00:00:00:00' })).toBeDefined();
    expect(screen.getByRole('button', { name: '00:00:03:00' })).toBeDefined();
  });

  it('goes to one when its timecode is pressed', async () => {
    const { onSeek } = mount([marker(90, 'interview')]);

    await userEvent.click(screen.getByRole('button', { name: '00:00:03:00' }));
    expect(onSeek).toHaveBeenCalledWith(90);
  });

  it('renames one in place', async () => {
    const { onEdit } = mount([marker(90, 'interview')]);

    await userEvent.dblClick(screen.getByText('interview'));
    const field = screen.getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'the good take{Enter}');

    expect(onEdit).toHaveBeenCalledWith(90, { label: 'the good take' });
  });

  it('removes one', async () => {
    const { onRemove } = mount([marker(90, 'interview')]);

    await userEvent.click(screen.getByRole('button', { name: 'Remove marker interview' }));
    expect(onRemove).toHaveBeenCalledWith(90);
  });

  it('carries a marker´s own colour rather than tinting the row', async () => {
    // The colours are the user's coding — a scene, a note, a problem — and a whole row in one would
    // make the list harder to read than the ruler it replaces.
    mount([marker(90, 'problem', '#ff0000')]);
    const row = screen.getByRole('button', { name: '00:00:03:00' }).parentElement!;
    expect(row.querySelector('[style*="color"]')).not.toBeNull();
  });
});
