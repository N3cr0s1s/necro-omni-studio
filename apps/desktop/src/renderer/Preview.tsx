import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type FrameIndex, type TimelineDocument } from '@nos/core';
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
}

export function Preview({ document: doc, frame, sidecar }: PreviewProps): ReactNode {
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
  const media = useMemo(() => createMediaTextures(sidecar), [sidecar]);
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
