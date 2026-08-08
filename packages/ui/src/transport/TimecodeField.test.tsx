// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_RATES, frameIndex } from '@nos/core';
import { TimecodeField } from './TimecodeField.js';

afterEach(cleanup);

function renderField(overrides: Partial<Parameters<typeof TimecodeField>[0]> = {}) {
  const onSeek = vi.fn();
  render(
    <TimecodeField frame={frameIndex(100)} frameRate={FRAME_RATES.WEB_30} onSeek={onSeek} {...overrides} />,
  );
  return onSeek;
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button'));
  return screen.getByLabelText('Go to timecode') as HTMLInputElement;
};

describe('reading', () => {
  it('shows the position', () => {
    renderField();
    expect(screen.getByRole('button').textContent).toBe('00:00:03:10');
  });

  it('is inert when nothing can act on a seek', () => {
    render(<TimecodeField frame={frameIndex(100)} frameRate={FRAME_RATES.WEB_30} />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('typing a position', () => {
  it('seeks to a full timecode', async () => {
    const user = userEvent.setup();
    const onSeek = renderField();
    const field = await open(user);

    await user.clear(field);
    await user.type(field, '00:00:12:15');
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSeek).toHaveBeenCalledWith(375);
  });

  it('seeks by a relative move from where the playhead is', async () => {
    const user = userEvent.setup();
    const onSeek = renderField();
    const field = await open(user);

    await user.clear(field);
    await user.type(field, '+30');
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSeek).toHaveBeenCalledWith(130);
  });

  it('lands on the last frame rather than refusing an entry past the end', async () => {
    const user = userEvent.setup();
    const onSeek = renderField({ duration: 300 });
    const field = await open(user);

    await user.clear(field);
    await user.type(field, '10:00:00:00');
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSeek).toHaveBeenCalledWith(299);
  });

  it('commits when the user clicks away, having plainly decided', async () => {
    const user = userEvent.setup();
    const onSeek = renderField();
    const field = await open(user);

    await user.clear(field);
    await user.type(field, '1215');
    fireEvent.blur(field);

    expect(onSeek).toHaveBeenCalledWith(375);
  });
});

describe('a refusal', () => {
  it('keeps the text and says what is wrong', async () => {
    // Clearing the field would destroy the thing the user was about to correct, and tell them
    // nothing about which of the accepted forms they nearly typed.
    const user = userEvent.setup();
    const onSeek = renderField();
    const field = await open(user);

    await user.clear(field);
    await user.type(field, 'nonsense');
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSeek).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Go to timecode') as HTMLInputElement).value).toBe('nonsense');
    expect(screen.getByRole('alert').textContent).toContain('not a timecode');
  });

  it('marks the field invalid for anyone not looking at the colour', async () => {
    const user = userEvent.setup();
    renderField();
    const field = await open(user);
    await user.clear(field);
    await user.type(field, 'nonsense');
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(screen.getByLabelText('Go to timecode').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('abandoning', () => {
  it('leaves the position alone on Escape', async () => {
    const user = userEvent.setup();
    const onSeek = renderField();
    const field = await open(user);

    await user.clear(field);
    await user.type(field, '1215');
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.getByRole('button').textContent).toBe('00:00:03:10');
  });
});

describe('while the field has focus', () => {
  it('keeps the transport’s own shortcuts out of it', async () => {
    // A space bar that started playback mid-edit, or an arrow key that stepped a frame instead of
    // moving the caret, would make the field unusable — and both are bound globally.
    const user = userEvent.setup();
    renderField();
    const field = await open(user);

    const seen: string[] = [];
    window.addEventListener('keydown', (event) => seen.push(event.key));

    fireEvent.keyDown(field, { key: ' ', bubbles: true });
    fireEvent.keyDown(field, { key: 'ArrowLeft', bubbles: true });

    expect(seen).toEqual([]);
  });
});
