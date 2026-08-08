import { describe, expect, it, vi } from 'vitest';
import {
  type Clip,
  type TextClip,
  type TimelineDocument,
  type TextTrack,
  FRAME_RATES,
  createDocument,
  frameIndex,
  projectId,
  sequenceId,
  trackId,
} from '@nos/core';
import { contentCacheKey } from '@nos/text';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import { prepareFrame } from './frame-render.js';
import type { MediaTextures } from './media-textures.js';
import type { MaskSource } from './mask-source.js';
import { createTextClip } from './TextInspector.js';
import { textMaxWidth } from './text-plan.js';

/**
 * Preparing a frame.
 *
 * This file exists because of a bug it would have caught. The export built its own plan **without** a
 * text cache key and never called `registerText`, so the rasterizer stored titles by content hash
 * while the plan asked for them by clip id — and every title was silently absent from every delivered
 * file. The preview showed it. §6.7's WYSIWYG guarantee is precisely that this cannot happen.
 *
 * So what is asserted here is not that the function runs. It is the *agreement* between the plan's
 * keys and the rasterizer's, which is the thing that was broken and which no test of either side
 * alone could see.
 */

const effects = createEffectRegistry(BUILTIN_EFFECTS);

function documentWith(clips: readonly Clip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === 'text' ? ({ ...track, clips } as TextTrack) : track,
      ),
    },
  };
}

const title = () => createTextClip('t1', 0) as Clip;

/** A registry that records what it was asked for rather than touching a driver. */
function fakeTextures() {
  const registerText = vi.fn(async () => []);
  const registerMasks = vi.fn();
  const prepare = vi.fn(async () => undefined);
  const media = {
    provider: () => {
      throw new Error('not used');
    },
    prepare,
    registerText,
    registerMasks,
    dispose: () => undefined,
  } as unknown as MediaTextures;
  return { media, registerText, registerMasks, prepare };
}

describe('text', () => {
  it('keys the plan the same way the rasterizer stores it', async () => {
    // The whole bug, in one assertion. The plan named clips and the rasterizer stored content hashes,
    // so `textTexture` found nothing and the layer drew nothing — in the *export* only, because only
    // the preview passed a key.
    const document = documentWith([title()]);
    const { media } = fakeTextures();

    const { plan } = await prepareFrame(media, { document, frame: frameIndex(0), effects });

    const layer = plan.items.find((item) => item.kind === 'layer' && item.layer.source.kind === 'text');
    expect(layer).toBeDefined();
    expect(layer?.kind === 'layer' && layer.layer.source).toMatchObject({
      cacheKey: contentCacheKey((title() as TextClip).content, textMaxWidth(document.resolution)),
    });
  });

  it('registers the titles before the plan is prepared', async () => {
    // A raster that has not landed is a texture the plan will ask for and never find — and unlike a
    // video frame it will not arrive on its own.
    const { media, registerText, prepare } = fakeTextures();
    await prepareFrame(media, { document: documentWith([title()]), frame: frameIndex(0), effects });

    expect(registerText).toHaveBeenCalled();
    expect(registerText.mock.invocationCallOrder[0]!).toBeLessThan(prepare.mock.invocationCallOrder[0]!);
  });

  it('reports a title that could not be rasterized rather than swallowing it', async () => {
    const { media, registerText } = fakeTextures();
    registerText.mockResolvedValue([{ clip: 't1', detail: 'no such font' }] as never);

    const prepared = await prepareFrame(media, {
      document: documentWith([title()]),
      frame: frameIndex(0),
      effects,
    });
    expect(prepared.textProblems).toEqual([{ clip: 't1', detail: 'no such font' }]);
  });
});

describe('masks', () => {
  it('registers what the source says for the frame being drawn', async () => {
    const source: MaskSource = {
      at: (frame) => [{ id: 'c1-mask' as never, frame: { frame: frameIndex(frame) } as never }],
    };
    const { media, registerMasks } = fakeTextures();

    await prepareFrame(media, {
      document: documentWith([]),
      frame: frameIndex(42),
      effects,
      masks: source,
    });

    expect(registerMasks).toHaveBeenCalledWith([{ id: 'c1-mask', frame: { frame: 42 } }]);
  });

  it('releases every mask when there is no source', async () => {
    // An empty list is meaningful: it is what unbinds the samplers, rather than leaving the last
    // frame's mask on screen.
    const { media, registerMasks } = fakeTextures();
    await prepareFrame(media, { document: documentWith([]), frame: frameIndex(0), effects });

    expect(registerMasks).toHaveBeenCalledWith([]);
  });
});

describe('waiting', () => {
  it('does not wait by default, because a frozen preview is worse than a blank layer', async () => {
    const { media, prepare } = fakeTextures();
    await prepareFrame(media, { document: documentWith([]), frame: frameIndex(0), effects });

    expect(prepare).toHaveBeenCalledWith(expect.anything(), {});
  });

  it('waits when asked, because a skipped layer in a delivered file is a missing shot', async () => {
    const { media, prepare } = fakeTextures();
    await prepareFrame(media, {
      document: documentWith([]),
      frame: frameIndex(0),
      effects,
      wait: true,
    });

    expect(prepare).toHaveBeenCalledWith(expect.anything(), { wait: true });
  });
});

describe('what the preview and the export share', () => {
  it('produces the same plan for the same frame, whatever the caller wants of it', async () => {
    // The property the guarantee rests on. `wait` is the one thing they may legitimately differ on,
    // and it must not reach the plan.
    const document = documentWith([title()]);
    const preview = await prepareFrame(fakeTextures().media, {
      document,
      frame: frameIndex(7),
      effects,
    });
    const exported = await prepareFrame(fakeTextures().media, {
      document,
      frame: frameIndex(7),
      effects,
      wait: true,
    });

    expect(exported.plan).toEqual(preview.plan);
  });
});
