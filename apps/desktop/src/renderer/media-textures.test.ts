// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetPath, assetPath } from '@nos/core';
import type { RenderPlan } from '@nos/compositor';
import { createMediaTextures, flipRows } from './media-textures.js';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * Which file a source is decoded from.
 *
 * The proxy substitution happens here and nowhere else, which makes this the one place the WYSIWYG
 * guarantee can be broken: the preview and the export share this decoder, and an export that quietly
 * read a downscaled intermediate would deliver a different file from the one that was approved, with
 * nothing on screen changing. So the substitution is a parameter, and the export passes none.
 */

const sidecar: SidecarInfo = { baseUrl: 'http://127.0.0.1:9000', token: 'tok', available: true };

/** Every `<video>` the decoder made, in order, since jsdom never attaches them to the document. */
let created: HTMLVideoElement[] = [];
let restore: () => void = () => undefined;

beforeEach(() => {
  created = [];
  const original = document.createElement.bind(document);
  const patched = ((tag: string, options?: ElementCreationOptions) => {
    const element = original(tag, options);
    if (tag === 'video') created.push(element as HTMLVideoElement);
    return element;
  }) as typeof document.createElement;

  document.createElement = patched;
  restore = () => {
    document.createElement = original;
  };
});

afterEach(() => {
  restore();
});

function planFor(asset: string): RenderPlan['items'] {
  return [
    {
      kind: 'layer',
      layer: {
        source: {
          kind: 'video',
          asset: assetPath(asset),
          sourceFrame: 0,
          sourceRate: { value: { numerator: 30, denominator: 1 } },
        },
      },
    },
  ] as unknown as RenderPlan['items'];
}

/** Drives the decoder the way a render does, and reports the URL it ended up asking for. */
function decode(textures: ReturnType<typeof createMediaTextures>, asset: string): string {
  void textures.prepare(planFor(asset), { wait: false });
  return created.at(-1)?.src ?? '';
}

describe('the decoded file', () => {
  it('is the source asset when nothing substitutes one', () => {
    // What the export gets. No resolver, no substitution, no way for a proxy to reach the delivery.
    const textures = createMediaTextures(sidecar);
    const url = decode(textures, 'media/4k.mov');

    expect(url).toContain(encodeURIComponent('media/4k.mov'));
    textures.dispose();
  });

  it('is the proxy when one is offered', () => {
    const textures = createMediaTextures(sidecar, {
      resolveAsset: (asset) =>
        asset === 'media/4k.mov' ? assetPath('cache/proxy_1080p30q23_abc.mp4') : asset,
    });
    const url = decode(textures, 'media/4k.mov');

    expect(url).toContain(encodeURIComponent('cache/proxy_1080p30q23_abc.mp4'));
    textures.dispose();
  });

  it('falls back to the original for a source with no proxy yet', () => {
    // A transcode takes as long as it takes. A preview that went blank while it ran would trade a
    // slow picture for no picture.
    const textures = createMediaTextures(sidecar, { resolveAsset: (asset: AssetPath) => asset });
    const url = decode(textures, 'media/pending.mov');

    expect(url).toContain(encodeURIComponent('media/pending.mov'));
    textures.dispose();
  });

  it('carries the token, because a video element cannot send a header', () => {
    const textures = createMediaTextures(sidecar);
    expect(decode(textures, 'media/a.mp4')).toContain('token=tok');
    textures.dispose();
  });

  it('decodes nothing when the sidecar is unavailable', () => {
    const textures = createMediaTextures({ ...sidecar, available: false });
    void textures.prepare(planFor('media/a.mp4'), { wait: false });

    expect(created).toHaveLength(0);
    textures.dispose();
  });
});

describe('when a proxy arrives mid-session', () => {
  it('switches to it', () => {
    let proxied = false;
    const textures = createMediaTextures(sidecar, {
      resolveAsset: (asset) => (proxied ? assetPath('cache/proxy.mp4') : asset),
    });

    expect(decode(textures, 'media/4k.mov')).toContain(encodeURIComponent('media/4k.mov'));
    proxied = true;

    expect(decode(textures, 'media/4k.mov')).toContain(encodeURIComponent('cache/proxy.mp4'));
    textures.dispose();
  });

  it('releases the decoder reading the original', () => {
    // Otherwise every proxied source holds two open decoders — and their buffers — for the session.
    let proxied = false;
    const textures = createMediaTextures(sidecar, {
      resolveAsset: (asset) => (proxied ? assetPath('cache/proxy.mp4') : asset),
    });

    decode(textures, 'media/4k.mov');
    const original = created.at(-1);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);

    proxied = true;
    decode(textures, 'media/4k.mov');

    expect(pause).toHaveBeenCalled();
    expect(original?.getAttribute('src')).toBeNull();
    pause.mockRestore();
    load.mockRestore();
    textures.dispose();
  });

  it('keeps one decoder when nothing changed', () => {
    const textures = createMediaTextures(sidecar);
    decode(textures, 'media/a.mp4');
    decode(textures, 'media/a.mp4');

    expect(created).toHaveLength(1);
    textures.dispose();
  });
});

/**
 * Row order for a mask upload.
 *
 * GL's texture origin is bottom-left and a decoded mask's is top-left. The element uploads in this
 * file hand that to the driver with `UNPACK_FLIP_Y_WEBGL`, which is only specified for DOM sources —
 * for an `ArrayBufferView` its behaviour has varied. Doing it here cannot be wrong in a way that only
 * shows up as a mask covering the wrong half of the picture, which is a failure no other test would
 * catch: an upside-down mask still renders, still has the right area, and is simply on the wrong thing.
 */
describe('flipping rows for a texture upload', () => {
  it('puts the last row first', () => {
    // Two rows of two RGBA pixels: row 0 all 1s, row 1 all 2s.
    const pixels = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect([...flipRows(pixels, 2, 2)]).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('leaves a single row alone', () => {
    const pixels = new Uint8Array([9, 8, 7, 6]);
    expect([...flipRows(pixels, 1, 1)]).toEqual([9, 8, 7, 6]);
  });

  it('is its own inverse, which is what makes it safe to reason about', () => {
    const pixels = Uint8Array.from({ length: 3 * 4 * 4 }, (_, index) => index % 251);
    expect([...flipRows(flipRows(pixels, 4, 3), 4, 3)]).toEqual([...pixels]);
  });

  it('keeps each row´s pixels in order, moving whole rows only', () => {
    // A flip that also reversed within a row would mirror the mask horizontally — visible only as a
    // mask on the wrong side of the subject.
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect([...flipRows(pixels, 2, 2)].slice(0, 8)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });
});
