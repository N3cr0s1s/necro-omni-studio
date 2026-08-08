import { type AssetPath, type FrameRate, frameRateToNumber } from '@nos/core';
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
 */

export interface MediaTextures {
  provider(gl: WebGL2RenderingContext): TextureProvider;
  /** Brings every source in the plan to its frame. Resolves when it can go no further. */
  prepare(items: RenderPlan['items'], options?: { readonly wait?: boolean }): Promise<void>;
  dispose(): void;
}

/** How long to wait for one seek before giving up on it. */
export const SEEK_TIMEOUT_MS = 5_000;

export function createMediaTextures(sidecar: SidecarInfo | undefined): MediaTextures {
  const elements = new Map<string, HTMLVideoElement | HTMLImageElement>();
  const textures = new Map<string, WebGLTexture>();
  let context: WebGL2RenderingContext | undefined;

  function urlFor(asset: AssetPath): string | undefined {
    if (sidecar === undefined || !sidecar.available) return undefined;
    // The token travels in the query because `<video src>` cannot send a header — the one reason the
    // sidecar accepts it there at all.
    return `${sidecar.baseUrl}/media/file?asset=${encodeURIComponent(asset)}&token=${encodeURIComponent(sidecar.token)}`;
  }

  function elementFor(source: LayerSource): HTMLVideoElement | HTMLImageElement | undefined {
    if (source.kind !== 'video' && source.kind !== 'image') return undefined;

    const existing = elements.get(source.asset);
    if (existing !== undefined) return existing;

    const url = urlFor(source.asset);
    if (url === undefined) return undefined;

    if (source.kind === 'image') {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = url;
      elements.set(source.asset, image);
      return image;
    }

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    elements.set(source.asset, video);
    return video;
  }

  return {
    provider(gl) {
      context = gl;
      return {
        textureFor(source) {
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
      for (const element of elements.values()) {
        if (element instanceof HTMLVideoElement) {
          element.pause();
          element.removeAttribute('src');
          element.load();
        }
      }
      elements.clear();

      if (context !== undefined) {
        for (const texture of textures.values()) context.deleteTexture(texture);
      }
      textures.clear();
    },
  };
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
