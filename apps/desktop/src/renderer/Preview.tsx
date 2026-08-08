import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type FrameIndex, type FrameRate, type TimelineDocument, frameRateToNumber } from '@nos/core';
import {
  type GlCompositor,
  type LayerSource,
  type RenderPlan,
  type RenderStats,
  type TextureProvider,
  createBuiltinPrograms,
  createGlCompositor,
  createProgramCache,
  createRenderTargetPool,
  buildRenderPlan,
} from '@nos/compositor';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import { Mono } from '@nos/ui';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * The preview surface.
 *
 * The same compositor the export uses — that is the spec's WYSIWYG requirement, and the reason there is
 * one implementation rather than a fast preview path and a correct export path. This component supplies
 * it with two things it cannot get itself: a GL context, and textures for decoded frames.
 *
 * Decoding is deliberately best-effort. A layer whose frame has not arrived is *skipped*, not waited for:
 * a preview that blocks on a seek turns a slow decode into a frozen window, and the compositor's
 * `layersSkipped` count is what tells the user a frame is still coming.
 */

export interface PreviewProps {
  readonly document: TimelineDocument;
  readonly frame: FrameIndex;
  /** Where the sidecar serves project files. Without it there is nothing to decode. */
  readonly sidecar: SidecarInfo | undefined;
}

export function Preview({ document: doc, frame, sidecar }: PreviewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<GlCompositor | undefined>(undefined);
  const [stats, setStats] = useState<RenderStats | undefined>(undefined);
  const [glError, setGlError] = useState<string | undefined>(undefined);

  const effects = useMemo(() => createEffectRegistry(BUILTIN_EFFECTS), []);
  const media = useMediaTextures(sidecar);

  // The context and its programs outlive every frame: compiling a shader per frame would cost more than
  // the render, and a lost context has to be handled once rather than at every draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true });
    if (gl === null) {
      setGlError('this machine has no WebGL2 context — the preview and export both need one');
      return;
    }
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    const programs = createProgramCache(gl, effects);
    const compositor = createGlCompositor({
      gl,
      programs,
      builtins: createBuiltinPrograms(gl),
      pool: createRenderTargetPool(gl),
      textures: media.provider(gl),
    });
    compositorRef.current = compositor;

    return () => {
      compositor.dispose();
      compositorRef.current = undefined;
    };
  }, [effects, media]);

  // One draw per document or playhead change. A requestAnimationFrame loop would redraw a still frame
  // sixty times a second and keep a laptop's fan on while nothing moves.
  useEffect(() => {
    const compositor = compositorRef.current;
    const canvas = canvasRef.current;
    if (compositor === undefined || canvas === null) return;

    canvas.width = doc.resolution.width;
    canvas.height = doc.resolution.height;

    const plan = buildRenderPlan({ document: doc, frame, effects });
    void media.prepare(plan.items).then(() => {
      const current = compositorRef.current;
      if (current === undefined) return;
      setStats(current.render(plan, null));
    });
  }, [doc, frame, effects, media]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--nos-bg-canvas)',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 12 }}>
        <canvas
          ref={canvasRef}
          aria-label="Preview"
          style={{
            // `max-width` and `max-height` constrain independently, so a 16:9 canvas in a 2:1 box gets
            // squashed rather than letterboxed. `aspect-ratio` is what keeps the framing honest — and a
            // preview that misreports framing is worse than no preview in an editor.
            aspectRatio: `${doc.resolution.width} / ${doc.resolution.height}`,
            maxWidth: '100%',
            maxHeight: '100%',
            width: 'auto',
            height: 'auto',
            background: '#000',
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, padding: '4px 12px', alignItems: 'center' }}>
        {glError !== undefined && <Mono tone="var(--nos-danger)">{glError}</Mono>}
        {glError === undefined && (
          <>
            <Mono tone="var(--nos-text-faint)">{`frame ${frame}`}</Mono>
            <Mono tone="var(--nos-text-faint)">{`${stats?.passesExecuted ?? 0} passes`}</Mono>
            {/* Skipped layers are reported rather than hidden: a black preview with no explanation is
                indistinguishable from a broken one. */}
            {(stats?.layersSkipped ?? 0) > 0 && (
              <Mono tone="var(--nos-warn)">{`${stats?.layersSkipped} layers still decoding`}</Mono>
            )}
            {(stats?.passthroughs.length ?? 0) > 0 && (
              <Mono tone="var(--nos-danger)">{`${stats?.passthroughs.length} effects failed to compile`}</Mono>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface MediaTextures {
  provider(gl: WebGL2RenderingContext): TextureProvider;
  /** Ensures every source in the plan has a decoded frame, as far as it can. */
  prepare(items: RenderPlan['items']): Promise<void>;
}

/**
 * Decoded frames, as textures.
 *
 * Uses `<video>` and `<img>` elements rather than WebCodecs: the sidecar already serves project files
 * over loopback, the browser's own decoders handle every container ffmpeg produced, and a seek on a
 * proxy is fast enough for scrubbing. WebCodecs would be faster for playback and is the natural next
 * step; it is not what makes the preview *correct*.
 */
function useMediaTextures(sidecar: SidecarInfo | undefined): MediaTextures {
  const elements = useRef(new Map<string, HTMLVideoElement | HTMLImageElement>());
  const textures = useRef(new Map<string, WebGLTexture>());

  return useMemo(() => {
    const urlFor = (asset: string): string | undefined => {
      if (sidecar === undefined || !sidecar.available) return undefined;
      // The token travels in the query because `<video src>` cannot send a header. Tolerable only
      // because the URL never leaves this process and the sidecar is loopback-only.
      return `${sidecar.baseUrl}/media/file?asset=${encodeURIComponent(asset)}&token=${encodeURIComponent(sidecar.token)}`;
    };

    const elementFor = (source: LayerSource): HTMLVideoElement | HTMLImageElement | undefined => {
      if (source.kind !== 'video' && source.kind !== 'image') return undefined;
      const url = urlFor(source.asset);
      if (url === undefined) return undefined;

      const existing = elements.current.get(source.asset);
      if (existing !== undefined) return existing;

      if (source.kind === 'image') {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.src = url;
        elements.current.set(source.asset, image);
        return image;
      }

      const video = window.document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'auto';
      video.src = url;
      elements.current.set(source.asset, video);
      return video;
    };

    return {
      provider(gl) {
        return {
          textureFor(source) {
            const element = elementFor(source);
            if (element === undefined) return undefined;
            if (element instanceof HTMLVideoElement && element.readyState < 2) return undefined;
            if (element instanceof HTMLImageElement && !element.complete) return undefined;

            const key = source.kind === 'video' || source.kind === 'image' ? source.asset : '';
            let texture = textures.current.get(key);
            if (texture === undefined) {
              const created = gl.createTexture();
              if (created === null) return undefined;
              texture = created;
              gl.bindTexture(gl.TEXTURE_2D, texture);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
              textures.current.set(key, texture);
            }

            gl.bindTexture(gl.TEXTURE_2D, texture);
            // Flipped: image and video sources have their origin top-left, GL's is bottom-left, and
            // getting this wrong renders every frame upside down.
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            return texture;
          },
          maskTexture: () => undefined,
        };
      },

      async prepare(items) {
        const seeks: Promise<void>[] = [];
        // A transition group carries two layers, both of which need their frame before it can blend —
        // seeking only one produces a dissolve between the right frame and whatever was left over.
        const layers = items.flatMap((item) =>
          item.kind === 'layer' ? [item.layer] : [item.group.from, item.group.to],
        );

        for (const layer of layers) {
          if (layer.source.kind !== 'video') continue;
          const element = elementFor(layer.source);
          if (!(element instanceof HTMLVideoElement)) continue;
          seeks.push(seekTo(element, layer.source.sourceFrame, layer.source.sourceRate));
        }
        await Promise.all(seeks);
      },
    };
  }, [sidecar]);
}

/**
 * Seeks a video element to a frame, resolving when it has one to show.
 *
 * The frame is counted in the **source's** rate, which the plan carries: a 24 fps clip on a 30 fps
 * timeline seeked at the project rate lands 25% away from the right moment, and the error grows with
 * the clip.
 *
 * Resolves rather than rejects on timeout: a seek that never completes must degrade to a skipped layer,
 * not to an unhandled rejection that takes the render loop with it.
 */
function seekTo(video: HTMLVideoElement, frame: number, rate: FrameRate): Promise<void> {
  const perSecond = frameRateToNumber(rate);
  const seconds = frame / perSecond;
  if (Number.isNaN(video.duration) && video.readyState < 1) {
    return new Promise((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      window.setTimeout(resolve, 1500);
    });
  }
  if (Math.abs(video.currentTime - seconds) < 1 / (2 * perSecond)) return Promise.resolve();

  return new Promise((resolve) => {
    video.addEventListener('seeked', () => resolve(), { once: true });
    window.setTimeout(resolve, 1500);
    video.currentTime = seconds;
  });
}
