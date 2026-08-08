// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransportBar } from './TransportBar.js';
import type { MediaTransportControls, MediaTransportState } from './use-media-transport.js';

/**
 * The controls under a preview.
 *
 * Named for the file throughout, because in a folder of `ad0eb912-5bf6-4d40…` a bare "Play" tells a
 * screen reader user which of forty takes exactly nothing.
 */

afterEach(cleanup);

const READY: MediaTransportState = {
  playing: false,
  currentSeconds: 3,
  durationSeconds: 12,
  muted: false,
  ready: true,
};

function controlsSpy(): MediaTransportControls & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    toggle: () => calls.push('toggle'),
    seek: (seconds) => calls.push(`seek:${seconds}`),
    restart: () => calls.push('restart'),
    toggleMuted: () => calls.push('muted'),
  };
}

const bar = (state: Partial<MediaTransportState> = {}, controls = controlsSpy()) => {
  render(<TransportBar state={{ ...READY, ...state }} controls={controls} label="take_09.flac" />);
  return controls;
};

describe('what the bar says', () => {
  it('offers to play a file that is not playing', () => {
    bar();
    expect(screen.getByRole('button', { name: 'Play take_09.flac' })).toBeTruthy();
  });

  it('offers to pause one that is', () => {
    bar({ playing: true });
    expect(screen.getByRole('button', { name: 'Pause take_09.flac' })).toBeTruthy();
  });

  it('shows the position and the length', () => {
    bar();
    expect(screen.getByText('0:03')).toBeTruthy();
    expect(screen.getByText('0:12')).toBeTruthy();
  });

  it('says nothing for a length it does not know yet', () => {
    // Rather than `0:00`, which reads as an empty file.
    bar({ durationSeconds: undefined });
    expect(screen.getByText('–:––')).toBeTruthy();
  });

  it('disables what cannot work before the file has loaded', () => {
    // A control that responds to nothing is worse than one that is visibly unavailable.
    bar({ ready: false });
    const play = screen.getByRole('button', { name: 'Play take_09.flac' }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
  });
});

describe('what the bar does', () => {
  it('toggles playback', async () => {
    const controls = bar();
    await userEvent.click(screen.getByRole('button', { name: 'Play take_09.flac' }));
    expect(controls.calls).toEqual(['toggle']);
  });

  it('returns to the start', async () => {
    const controls = bar();
    await userEvent.click(screen.getByRole('button', { name: 'Restart take_09.flac' }));
    expect(controls.calls).toEqual(['restart']);
  });

  it('mutes and unmutes', async () => {
    const controls = bar({ muted: true });
    await userEvent.click(screen.getByRole('button', { name: 'Unmute take_09.flac' }));
    expect(controls.calls).toEqual(['muted']);
  });

  it('scrubs with a single thumb', () => {
    // Handed a bare number the slider falls back to `[min, max]` and grows a second thumb, which on a
    // scrubber reads as a range selection the user cannot undo.
    bar();
    // `hidden: true` because Base UI leaves a thumb `visibility: hidden` until it has measured the
    // track, and jsdom never lays anything out. In a browser it is visible and reachable.
    expect(screen.getAllByRole('slider', { hidden: true })).toHaveLength(1);
  });
});

describe('a file with no length', () => {
  it('cannot be scrubbed', () => {
    bar({ durationSeconds: undefined });
    const slider = screen.getByRole('slider', { hidden: true }) as HTMLInputElement;
    expect(slider.disabled).toBe(true);
  });

  it('does not seek past its own end when one appears', () => {
    // The position can briefly exceed a duration that arrived late, and a slider whose value is above
    // its max renders its thumb outside the track.
    const controls = controlsSpy();
    render(
      <TransportBar
        state={{ ...READY, currentSeconds: 99, durationSeconds: 12 }}
        controls={controls}
        label="take_09.flac"
      />,
    );
    expect(screen.getByRole('slider', { hidden: true }).getAttribute('aria-valuenow')).toBe('12');
  });
});

describe('the label', () => {
  it('names the file on every control', () => {
    // Forty takes called `ad0eb912-…` are told apart by nothing else.
    bar();
    for (const name of [
      'Play take_09.flac',
      'Restart take_09.flac',
      'Seek take_09.flac',
      'Mute take_09.flac',
    ]) {
      expect(screen.getByLabelText(name), name).toBeTruthy();
    }
  });

  it('is not a spy on the controls it does not touch', () => {
    const controls = bar();
    expect(controls.calls).toEqual([]);
    expect(vi.isMockFunction(controls.toggle)).toBe(false);
  });
});
