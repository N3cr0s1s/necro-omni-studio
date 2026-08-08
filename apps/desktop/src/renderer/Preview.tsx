import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type AssetPath, type FrameIndex, type TimelineDocument } from '@nos/core';
import {
  type GlCompositor,
  type RenderStats,
  createBuiltinPrograms,
  createGlCompositor,
  createProgramCache,
  createRenderTargetPool,
  buildRenderPlan,
} from '@nos/compositor';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import { Mono } from '@nos/ui';
import { createMediaTextures } from './media-textures.js';
import { textCacheKeyFor, textClipsOf } from './text-plan.js';
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
  /**
   * Redirects a source asset to its editing proxy.
   *
   * The preview's alone. The export deliberately does not take one: preview and delivery run the
   * same plan, and encoding the delivery from a downscaled intermediate would break that guarantee
   * without anything on screen changing.
   */
  readonly resolveAsset?: (asset: AssetPath) => AssetPath;
}

export function Preview({ document: doc, frame, sidecar, resolveAsset }: PreviewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<GlCompositor | undefined>(undefined);
  const [stats, setStats] = useState<RenderStats | undefined>(undefined);
  /** Items the plan carried, so "nothing is visible" can be told apart from "nothing was planned". */
  const [planned, setPlanned] = useState(0);
  const [textProblems, setTextProblems] = useState<readonly { clip: string; detail: string }[]>([]);
  const [glError, setGlError] = useState<string | undefined>(undefined);

  const effects = useMemo(() => createEffectRegistry(BUILTIN_EFFECTS), []);
  // The same decoder the export uses. Two of them would eventually disagree about which frame a source
  // time lands on, and the delivered file would differ from what the user approved.
  const media = useMemo(
    () => createMediaTextures(sidecar, resolveAsset === undefined ? {} : { resolveAsset }),
    [sidecar, resolveAsset],
  );
  useEffect(() => () => media.dispose(), [media]);

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

    // Text is registered from the document, because the plan deliberately carries only a cache key —
    // the compositor knows nothing about fonts and must not have to.
    const plan = buildRenderPlan({
      document: doc,
      frame,
      effects,
      textCacheKey: textCacheKeyFor(doc.resolution),
    });
    void media
      .registerText(textClipsOf(doc), doc.resolution)
      .then((problems) => {
        setTextProblems(problems);
        return media.prepare(plan.items);
      })
      .then(() => {
        const current = compositorRef.current;
        if (current === undefined) return;
        setPlanned(plan.items.length);
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
      {/*
        The canvas is taken out of flow and pinned to this box, and the picture is letterboxed inside
        it by `object-fit` — which a canvas honours like any other replaced element. The framing stays
        honest, which matters more here than anywhere: a preview that misreports framing is worse than
        no preview at all. The drawing buffer is sized from the project resolution above and never
        from the layout, so there is nothing for the two to disagree about.

        It is pinned rather than sized because of what it replaces. `aspect-ratio` with `max-width` and
        `max-height` overflowed this box by up to 149 px and painted over the status line below it —
        "the preview is covered". The percentage heights that were meant to hold it in fell back to the
        intrinsic ratio, because a percentage height inside an auto-sized grid row is cyclic and
        resolves to `auto`. An absolutely positioned box has a definite containing block and cannot
        overflow its parent or disturb a sibling, so the fault is unavailable rather than corrected.
      */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          aria-label="Preview"
          style={{
            position: 'absolute',
            inset: 12,
            width: 'calc(100% - 24px)',
            height: 'calc(100% - 24px)',
            objectFit: 'contain',
            background: '#000',
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, padding: '4px 12px', alignItems: 'center' }}>
        {glError !== undefined && <Mono tone="var(--nos-danger)">{glError}</Mono>}
        {glError === undefined && (
          <>
            <Mono tone="var(--nos-text-faint)">{`frame ${frame}`}</Mono>
            <Mono tone="var(--nos-text-faint)">{`${planned} layers`}</Mono>
            <Mono tone="var(--nos-text-faint)">{`${stats?.passesExecuted ?? 0} passes`}</Mono>
            {/* Skipped layers are reported rather than hidden: a black preview with no explanation is
                indistinguishable from a broken one. */}
            {(stats?.layersSkipped ?? 0) > 0 && (
              <Mono tone="var(--nos-warn)">{`${stats?.layersSkipped} layers still decoding`}</Mono>
            )}
            {textProblems.length > 0 && (
              <Mono tone="var(--nos-danger)">{`title: ${textProblems[0]?.detail ?? ''}`}</Mono>
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
