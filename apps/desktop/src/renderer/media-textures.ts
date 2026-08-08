import {
  type AssetPath,
  type FrameRate,
  type Resolution,
  type TextClip,
  type TextContent,
  frameRateToNumber,
} from '@nos/core';
import { type RasterizedText, contentCacheKey, createCanvasRasterizer } from '@nos/text';
import { textMaxWidth } from './text-plan.js';
import type { LayerSource, RenderPlan, TextureProvider } from '@nos/compositor';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * Decoded frames, as textures.
 *
 * Shared by the preview and the export because the spec's WYSIWYG guarantee is not only about the
 * compositor — it is about the *pixels going in*. Two decoders would eventually disagree about which
 * frame a given source time lands on, and the export would differ from what the user approved.
 *
 * They differ in exactly one respect, which is the `wait` flag on `prepare`:
 *
 * - **Preview never waits.** A layer whose frame has not arrived is skipped and counted; blocking on a
 *   seek turns a slow decode into a frozen window.
 * - **Export always waits.** A skipped layer there is a missing shot in a delivered file, which is
 *   unacceptable in a way a momentarily-blank preview is not.
 *
 * `<video>` and `<img>` rather than WebCodecs: the sidecar already serves project files over loopback,
 * the browser's decoders handle every container ffmpeg produces, and a seek is fast enough for
 * scrubbing. WebCodecs is the natural next step for smooth playback of long clips; it is not what makes
 * the output *correct*.
 *
 * Text is rasterized here too, and cached by the **content hash** rather than by clip id. The spec is
 * explicit about why: an animated text clip must rasterize once for its whole duration, so the key must
 * cover exactly the properties that change pixels and nothing that only moves them. Two clips with
 * identical styling then share one texture, which is the common case for a lower third that repeats.
 */

export interface MediaTextures {
  provider(gl: WebGL2RenderingContext): TextureProvider;
  /** Brings every source in the plan to its frame. Resolves when it can go no further. */
  prepare(items: RenderPlan['items'], options?: { readonly wait?: boolean }): Promise<void>;
  /**
   * Registers the text a plan will ask for.
   *
   * Separate from `prepare` because rasterization needs the *document*, not the plan: the plan carries
   * only a cache key and a reveal fraction, deliberately, so the compositor stays ignorant of fonts.
   */
  registerText(clips: readonly TextClip[], resolution: Resolution): Promise<readonly TextRasterProblem[]>;
  dispose(): void;
}

/**
 * A title that could not be rasterized.
 *
 * Reported rather than swallowed. A missing font leaves a blank frame, and a blank frame with no
 * explanation is the failure this project treats as a defect everywhere else.
 */
export interface TextRasterProblem {
  readonly clip: string;
  readonly detail: string;
}

/** How long to wait for one seek before giving up on it. */
export const SEEK_TIMEOUT_MS = 5_000;

export interface MediaTextureOptions {
  /**
   * Substitutes the asset actually decoded for a source asset.
   *
   * The seam editing proxies plug into, and deliberately a *function* rather than a map: the preview
   * hands in one that redirects to a proxy, the export hands in nothing, and a future mode — full
   * resolution for the selected clip, a coarser proxy while scrubbing — is another implementation of
   * the same one-line contract rather than a new branch in here.
   */
  readonly resolveAsset?: (asset: AssetPath) => AssetPath;
}

export function createMediaTextures(
  sidecar: SidecarInfo | undefined,
  options: MediaTextureOptions = {},
): MediaTextures {
  /**
   * Decoders by source asset, with the URL each is decoding.
   *
   * The URL is held alongside because it can change under a stable asset: a proxy finishing
   * mid-session redirects the same source to a different file, and the element decoding the original
   * has to be released rather than left buffering a file nothing will draw again.
   */
  const elements = new Map<string, { url: string; element: HTMLVideoElement | HTMLImageElement }>();
  const textures = new Map<string, WebGLTexture>();
  /** Rasterized text by cache key, ready to upload. */
  const rasters = new Map<string, RasterizedText>();
  /** Uploads a driver refused, surfaced on the next `registerText` rather than lost. */
  const uploadFailures = new Map<string, string>();
  let context: WebGL2RenderingContext | undefined;

  const rasterizer = createCanvasRasterizer({
    // A DOM canvas rather than an `OffscreenCanvas`, despite the latter keeping rasterization off the
    // main thread: some GL backends — SwiftShader among them — will not accept an `OffscreenCanvas` as
    // a texture source, and the failure mode is a *silent* one. The texture uploads, samples as fully
    // transparent, and the title simply is not there with nothing reported anywhere.
    createCanvas: (width, height) => Object.assign(document.createElement('canvas'), { width, height }),
    // Rasterizing at 1x and scaling up is visibly soft, and a title is the one element a viewer reads
    // rather than glances at. Capped by the rasterizer so a 3x ratio on a 4K output cannot explode.
    pixelRatio: 2,
  });

  function urlFor(asset: AssetPath): string | undefined {
    if (sidecar === undefined || !sidecar.available) return undefined;
    const resolved = options.resolveAsset?.(asset) ?? asset;
    // The token travels in the query because `<video src>` cannot send a header — the one reason the
    // sidecar accepts it there at all.
    return `${sidecar.baseUrl}/media/file?asset=${encodeURIComponent(resolved)}&token=${encodeURIComponent(sidecar.token)}`;
  }

  function elementFor(source: LayerSource): HTMLVideoElement | HTMLImageElement | undefined {
    if (source.kind !== 'video' && source.kind !== 'image') return undefined;

    const url = urlFor(source.asset);
    if (url === undefined) return undefined;

    const existing = elements.get(source.asset);
    if (existing !== undefined && existing.url === url) return existing.element;
    // A different URL for the same asset means a proxy arrived. The old decoder is released here
    // rather than at teardown, or every proxied source would hold two open decoders for the session.
    if (existing !== undefined) release(existing.element);

    if (source.kind === 'image') {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = url;
      elements.set(source.asset, { url, element: image });
      return image;
    }

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    elements.set(source.asset, { url, element: video });
    return video;
  }

  function release(element: HTMLVideoElement | HTMLImageElement): void {
    if (!(element instanceof HTMLVideoElement)) return;
    element.pause();
    element.removeAttribute('src');
    element.load();
  }

  return {
    provider(gl) {
      context = gl;
      return {
        textureFor(source) {
          if (source.kind === 'text') return textTexture(gl, source.cacheKey);

          const element = elementFor(source);
          if (element === undefined) return undefined;
          if (element instanceof HTMLVideoElement && element.readyState < 2) return undefined;
          if (element instanceof HTMLImageElement && !element.complete) return undefined;

          const key = source.kind === 'video' || source.kind === 'image' ? source.asset : '';
          let texture = textures.get(key);
          if (texture === undefined) {
            const created = gl.createTexture();
            if (created === null) return undefined;
            texture = created;
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            textures.set(key, texture);
          }

          gl.bindTexture(gl.TEXTURE_2D, texture);
          // Flipped: image and video sources have their origin top-left and GL's is bottom-left. Getting
          // this wrong renders every frame upside down — in the preview *and* in the delivered file.
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          return texture;
        },
        maskTexture: () => undefined,
      };
    },

    async registerText(clips, resolution) {
      const problems: TextRasterProblem[] = [];
      for (const clip of clips) {
        const failed = uploadFailures.get(contentCacheKey(clip.content, textMaxWidth(resolution)));
        if (failed !== undefined) problems.push({ clip: clip.id, detail: failed });
        const maxWidth = textMaxWidth(resolution);
        const key = contentCacheKey(clip.content, maxWidth);
        if (rasters.has(key)) continue;

        try {
          const measured = await rasterizer.rasterize(clip.content, maxWidth);
          if (measured.width <= 0 || measured.height <= 0) {
            throw new Error(`rasterized to ${measured.width}x${measured.height}`);
          }
          // Composed onto a frame-sized surface at its natural pixel size. The compositor draws every
          // layer as a fullscreen quad — right for video, which fills the frame — so a title uploaded at
          // its own dimensions would be stretched to 1080 tall and the `size` control would mean
          // nothing. Placing it here keeps that model intact and makes the size a real pixel size.
          const raster = composeOntoFrame(measured, clip.content.align, resolution);
          // An empty raster is always a bug — a missing font, a zero-alpha colour, a measurement that
          // came back blank — and it presents as a title that simply is not there. Cheap to check once
          // per key, and it turns an invisible failure into a sentence.
          const ink = inkCoverage(raster);
          if (ink === 0) {
            throw new Error(`rasterized ${raster.width}x${raster.height} with no visible pixels`);
          }
          rasters.set(key, raster);
          // The texture is keyed the same way, so a re-render reuses it without touching the canvas.
          textures.delete(key);
        } catch (error) {
          // The clip goes un-drawn rather than taking the frame down, but the reason is carried out so
          // the preview can say why instead of showing an unexplained blank.
          problems.push({
            clip: clip.id,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return problems;
    },

    async prepare(items, options = {}) {
      // A transition group carries two layers and blends both: seeking only one produces a dissolve
      // between the right frame and whatever was left over from the last one.
      const layers = items.flatMap((item) =>
        item.kind === 'layer' ? [item.layer] : [item.group.from, item.group.to],
      );

      const seeks: Promise<void>[] = [];
      for (const layer of layers) {
        if (layer.source.kind !== 'video') continue;
        const element = elementFor(layer.source);
        if (!(element instanceof HTMLVideoElement)) continue;
        seeks.push(seekTo(element, layer.source.sourceFrame, layer.source.sourceRate, options.wait === true));
      }
      await Promise.all(seeks);
    },

    dispose() {
      for (const entry of elements.values()) release(entry.element);
      elements.clear();

      if (context !== undefined) {
        for (const texture of textures.values()) context.deleteTexture(texture);
      }
      textures.clear();
      rasters.clear();
    },
  };

  /**
   * Fraction of pixels with any alpha.
   *
   * Sampled rather than exhaustive: a title is tens of thousands of pixels and this runs once per cache
   * key, but the answer only needs to distinguish "some ink" from "none".
   */
  /**
   * Places a rasterized title on a frame-sized transparent surface.
   *
   * Horizontally by the content's own alignment, vertically in the lower third — where a title sits
   * unless it is moved, and the position the clip's transform then offsets from.
   *
   * This exists because the compositor draws every layer as a fullscreen quad, which is right for video
   * and wrong for a title: uploaded at its own dimensions a title would be stretched to the full frame
   * height and the `size` control would mean nothing. Composing here keeps the compositor's model intact
   * and makes the size a real pixel size.
   */
  function composeOntoFrame(
    raster: RasterizedText,
    align: TextContent['align'],
    resolution: Resolution,
  ): RasterizedText {
    const canvas = Object.assign(document.createElement('canvas'), {
      width: resolution.width,
      height: resolution.height,
    });
    const surface = canvas.getContext('2d');
    if (surface === null) return raster;

    const margin = Math.round(resolution.width * 0.05);
    const x =
      align === 'left'
        ? margin
        : align === 'right'
          ? resolution.width - raster.width - margin
          : Math.round((resolution.width - raster.width) / 2);
    const y = Math.round(resolution.height * 0.72 - raster.height / 2);

    surface.drawImage(raster.image as CanvasImageSource, x, y);
    return { ...raster, width: resolution.width, height: resolution.height, image: canvas };
  }

  function inkCoverage(raster: RasterizedText): number {
    const canvas = raster.image as HTMLCanvasElement | OffscreenCanvas;
    const context = (canvas as HTMLCanvasElement).getContext?.('2d') as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (context === null || context === undefined) return 1;

    const { data } = context.getImageData(0, 0, raster.width, raster.height);
    let inked = 0;
    const step = 4 * 16;
    for (let index = 3; index < data.length; index += step) {
      if ((data[index] ?? 0) > 8) inked += 1;
    }
    return inked;
  }

  /** Uploads a rasterized text image, once per cache key. */
  function textTexture(gl: WebGL2RenderingContext, key: string): WebGLTexture | undefined {
    const existing = textures.get(key);
    if (existing !== undefined) return existing;

    const raster = rasters.get(key);
    if (raster === undefined) return undefined;

    const texture = gl.createTexture();
    if (texture === null) return undefined;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // Canvas 2D output is premultiplied, and GL assumes straight alpha unless told: without this a
    // title's edges fringe dark against bright footage.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, raster.image as TexImageSource);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // Checked, because an upload a driver refuses leaves a texture that samples as fully transparent —
    // a title that is simply absent, with nothing reported anywhere.
    const failure = gl.getError();
    if (failure !== gl.NO_ERROR) {
      uploadFailures.set(key, `the driver refused the text texture (0x${failure.toString(16)})`);
      gl.deleteTexture(texture);
      return undefined;
    }

    textures.set(key, texture);
    return texture;
  }
}

/**
 * Seeks a video element to a frame.
 *
 * The frame is counted in the **source's** rate, which the plan carries: a 24 fps clip on a 30 fps
 * timeline seeked at the project rate lands 25% away from the right moment, and the error grows with the
 * clip.
 *
 * Resolves rather than rejects on timeout. For the preview that degrades to a skipped layer; for the
 * export the frame is written as whatever the decoder last produced, which is a visible defect the
 * caller can report — an unhandled rejection would instead abandon the encode mid-file.
 */
async function seekTo(video: HTMLVideoElement, frame: number, rate: FrameRate, wait: boolean): Promise<void> {
  const perSecond = frameRateToNumber(rate);
  const seconds = frame / perSecond;

  if (video.readyState < 1) {
    await once(video, 'loadedmetadata', wait ? SEEK_TIMEOUT_MS : 1_500);
  }
  // Within half a frame is the same frame. Re-seeking there costs a decode and changes nothing.
  if (Math.abs(video.currentTime - seconds) < 1 / (2 * perSecond)) return;

  const settled = once(video, 'seeked', wait ? SEEK_TIMEOUT_MS : 1_500);
  video.currentTime = seconds;
  await settled;
}

function once(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      target.removeEventListener(event, done);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    target.addEventListener(event, done, { once: true });
  });
}
