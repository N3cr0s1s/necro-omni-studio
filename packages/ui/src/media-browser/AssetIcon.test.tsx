// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetIcon } from './AssetIcon.js';

/**
 * The mark beside a row in the browser.
 *
 * A coloured square said there were four kinds of thing without saying which was which. What matters
 * now is that the glyph *names* the kind — the colour is reinforcement, not the message, which is
 * also what makes the browser readable to someone who cannot separate the hues.
 */

afterEach(cleanup);

const kindOf = () => document.querySelector('[data-asset-icon]')?.getAttribute('data-asset-icon');

describe('naming the kind', () => {
  it('draws a different glyph per asset type', () => {
    for (const assetType of ['video', 'audio', 'image', 'text'] as const) {
      render(<AssetIcon assetType={assetType} />);
      expect(kindOf()).toBe(assetType);
      cleanup();
    }
  });

  it('draws a folder for a directory', () => {
    render(<AssetIcon isDirectory name="media" />);
    expect(kindOf()).toBe('folder');
  });

  it('draws a plain page for a file it cannot type', () => {
    // Honest: it is a file, and that is all the application knows about it.
    render(<AssetIcon />);
    expect(kindOf()).toBe('unknown');
  });
});

/**
 * The colour is asserted as a class name rather than a computed value, and that is not a shortcut:
 * these are theme roles, so the resolved colour is different in dark mode and under another palette,
 * while the *role* — "audio and video are different categories" — is the thing that must hold.
 */
const toneOf = () => document.querySelector('[data-asset-icon]')?.getAttribute('class') ?? '';

describe('the colour', () => {
  it('paints from the theme, never from a literal', () => {
    render(<AssetIcon assetType="audio" />);
    expect(toneOf()).toMatch(/text-(chart-[1-5]|muted-foreground)/);
    expect(toneOf()).not.toMatch(/#|rgb|oklch/);
  });

  it('separates one asset type from another', () => {
    render(<AssetIcon assetType="audio" />);
    const audio = toneOf();
    cleanup();

    render(<AssetIcon assetType="video" />);
    expect(toneOf()).not.toBe(audio);
  });

  it('gives the reserved project folders their established meanings', () => {
    render(<AssetIcon isDirectory name="media" />);
    const media = toneOf();
    cleanup();

    render(<AssetIcon isDirectory name="generated" />);
    expect(toneOf()).not.toBe(media);
  });
});

describe('expansion', () => {
  it('opens the folder glyph, so the state shows in more than the chevron', () => {
    render(<AssetIcon isDirectory name="anything" />);
    const closed = document.querySelector('[data-asset-icon]')?.innerHTML;
    cleanup();

    render(<AssetIcon isDirectory name="anything" open />);
    expect(document.querySelector('[data-asset-icon]')?.innerHTML).not.toBe(closed);
  });

  it('leaves a reserved folder alone, because its glyph says what is in it', () => {
    // `generated/` is drawn by what it holds rather than by whether it is open; swapping it for an
    // open folder on expansion would throw that away.
    render(<AssetIcon isDirectory name="generated" />);
    const closed = document.querySelector('[data-asset-icon]')?.innerHTML;
    cleanup();

    render(<AssetIcon isDirectory name="generated" open />);
    expect(document.querySelector('[data-asset-icon]')?.innerHTML).toBe(closed);
  });
});

describe('accessibility', () => {
  it('is decoration, not content: the row already names the file', () => {
    render(<AssetIcon assetType="video" />);
    expect(document.querySelector('[data-asset-icon]')?.getAttribute('aria-hidden')).toBe('true');
  });
});
