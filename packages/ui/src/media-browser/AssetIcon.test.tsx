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

describe('the colour', () => {
  it('keeps the domain hue, so glyph and palette reinforce each other', () => {
    render(<AssetIcon assetType="audio" />);
    const icon = document.querySelector('[data-asset-icon]') as SVGElement;
    expect(icon.style.color).not.toBe('');
  });

  it('gives the reserved project folders their established colours', () => {
    render(<AssetIcon isDirectory name="media" />);
    const media = (document.querySelector('[data-asset-icon]') as SVGElement).style.color;
    cleanup();

    render(<AssetIcon isDirectory name="generated" />);
    const generated = (document.querySelector('[data-asset-icon]') as SVGElement).style.color;
    expect(media).not.toBe(generated);
  });
});

describe('accessibility', () => {
  it('is decoration, not content: the row already names the file', () => {
    render(<AssetIcon assetType="video" />);
    expect(document.querySelector('[data-asset-icon]')?.getAttribute('aria-hidden')).toBe('true');
  });
});
