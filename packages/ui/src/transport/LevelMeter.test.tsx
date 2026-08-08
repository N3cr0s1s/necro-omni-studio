// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  METER_FLOOR_DB,
  METER_WARN_DB,
  LevelMeter,
  describeLevel,
  meterPosition,
  meterTone,
} from './LevelMeter.js';

/**
 * The output meter.
 *
 * The scale is the part worth pinning down. A meter is read against decibel marks, and a linear bar
 * spends nine tenths of its travel in the top 20 dB — where the difference between "present" and
 * "inaudible" would be invisible. Everything else here follows from that, and from the fact that a
 * clip which happened while the editor looked away is exactly the one worth knowing about.
 */

afterEach(cleanup);

function fills(): number[] {
  return [...document.querySelectorAll('[data-slot="progress-indicator"]')].map((node) =>
    Number.parseFloat((node as HTMLElement).style.width),
  );
}

describe('the scale', () => {
  it('puts full scale at the top', () => {
    expect(meterPosition(1)).toBe(1);
  });

  it('puts silence at the bottom', () => {
    expect(meterPosition(0)).toBe(0);
  });

  it('is logarithmic, not linear', () => {
    // Half amplitude is −6 dBFS, which on a 48 dB scale sits at 7/8 of the way up. A linear bar would
    // put it at the halfway mark and waste the range where mixing decisions are actually made.
    expect(meterPosition(0.5)).toBeCloseTo(0.875, 2);
  });

  it('bottoms out rather than going negative below the floor', () => {
    expect(meterPosition(1e-9)).toBe(0);
  });

  it('does not overshoot for a peak above full scale', () => {
    // A sum can exceed unity before the master gain is applied; the bar must not run past its box.
    expect(meterPosition(4)).toBe(1);
  });

  it('treats a nonsensical reading as silence rather than drawing something', () => {
    expect(meterPosition(Number.NaN)).toBe(0);
    expect(meterPosition(-1)).toBe(0);
  });
});

describe('the zones', () => {
  it('paints from a theme role, never from a literal colour', () => {
    for (const peak of [0.1, 0.9, 1]) {
      expect(meterTone(peak)).toMatch(/bg-(primary|destructive)/);
      expect(meterTone(peak)).not.toMatch(/#|rgb|oklch/);
    }
  });

  it('is one colour through the usable range', () => {
    expect(meterTone(0.1)).toBe(meterTone(0.4));
  });

  it('changes at the headroom mark', () => {
    // −6 dBFS: a mix peaking above it has little room left for what mastering adds.
    const below = meterTone(10 ** ((METER_WARN_DB - 1) / 20));
    const above = meterTone(10 ** ((METER_WARN_DB + 1) / 20));
    expect(below).not.toBe(above);
  });

  it('changes again at full scale', () => {
    const under = meterTone(0.9);
    const over = meterTone(1);
    expect(under).not.toBe(over);
  });
});

describe('drawing', () => {
  it('draws one bar per channel', () => {
    render(<LevelMeter peaks={[0.5, 0.25]} />);
    expect(fills()).toHaveLength(2);
  });

  it('keeps its shape with nothing playing', () => {
    // A meter that appeared and disappeared would move the transport's controls under the pointer
    // every time playback started.
    render(<LevelMeter />);
    expect(fills()).toEqual([0, 0]);
  });

  it('draws the louder channel higher', () => {
    render(<LevelMeter peaks={[0.9, 0.1]} />);
    const [left, right] = fills();
    expect(left).toBeGreaterThan(right!);
  });

  it('does not animate the bar', () => {
    // The decay that makes a peak readable is the engine's, applied to the value. Animating on top of
    // it would draw a level that was never measured — so the registry's own `transition-all` on the
    // indicator has to be turned off, and this is the assertion that notices if it comes back.
    render(<LevelMeter peaks={[0.5]} />);
    const channel = document.querySelector('[data-meter-channel]') as HTMLElement;
    expect(channel.className).toContain('[&_[data-slot=progress-indicator]]:transition-none');
  });

  it('keeps the bars out of the accessibility tree, because the meter carries the reading', () => {
    // Two nested progress bars would announce a percentage the meter does not use, twice, and bury
    // the clipping state underneath it.
    render(<LevelMeter peaks={[0.5, 0.5]} />);
    for (const channel of document.querySelectorAll('[data-meter-channel]')) {
      expect(channel.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('the clip indicator', () => {
  it('latches, because a clip that happened a moment ago still matters', () => {
    render(<LevelMeter peaks={[0.1]} clipped />);
    expect(screen.getByLabelText('Output clipped — click to reset')).toBeDefined();
  });

  it('is acknowledged by clicking it', () => {
    const onClearClip = vi.fn();
    render(<LevelMeter peaks={[0.1]} clipped onClearClip={onClearClip} />);

    screen.getByLabelText('Output clipped — click to reset').click();
    expect(onClearClip).toHaveBeenCalledTimes(1);
  });

  it('cannot be clicked when there is nothing to acknowledge', () => {
    render(<LevelMeter peaks={[0.1]} onClearClip={vi.fn()} />);
    const button = screen.getByLabelText('Output has not clipped') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe('what a screen reader hears', () => {
  it('reports the level as a number, not as a picture of one', () => {
    expect(describeLevel([0.5, 0.25], false)).toBe('-6.0 dBFS');
  });

  it('reports the louder channel, which is the one that clips', () => {
    expect(describeLevel([0.1, 1], false)).toBe('0.0 dBFS');
  });

  it('says silent rather than reciting the floor', () => {
    expect(describeLevel([0, 0], false)).toBe('silent');
  });

  it('carries the clipping state, which colour alone cannot', () => {
    expect(describeLevel([1], true)).toContain('clipped');
  });

  it('exposes the reading on the meter itself', () => {
    render(<LevelMeter peaks={[0.5]} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toBe('-6.0 dBFS');
    expect(screen.getByRole('meter').getAttribute('aria-valuemin')).toBe(String(METER_FLOOR_DB));
  });
});
