import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type AssetPath, type FrameIndex, type TimelineDocument } from '@nos/core';
import {
  type GlCompositor,
  type RenderStats,
  createBuiltinPrograms,
  createGlCompositor,
  createProgramCache,
  createRenderTargetPool,
  describeShaderError,
} from '@nos/compositor';
import type { EffectRegistry } from '@nos/effects';
import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';
import { createMediaTextures } from './media-textures.js';
import { passBudgetNote, prepareFrame } from './frame-render.js';
import { describeZoom, usePreviewZoom } from './use-preview-zoom.js';

/**
 * How much one wheel notch changes the zoom.
 *
 * A quarter, so getting from fit to a pixel-level look is a handful of notches rather than one — the
 * point of zooming here is to *arrive* at a scale worth judging, and a coarse step jumps over it.
 */
const ZOOM_STEP = 1.25;
import type { SidecarInfo } from '../main/ipc-contract.js';
import type { MaskSource } from './mask-source.js';

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
  /**
   * Drawn over the picture, given the picture's own size.
   *
   * How mask points are placed: they are normalized against the *frame*, so they can only be put
   * where the frame is — and the frame is letterboxed inside the canvas, which is a rectangle
   * nothing outside this component can compute. Handing it out is the whole point of the callback;
   * an overlay sized to the canvas box would place every point wrong on any clip whose aspect does
   * not match the project's.
   *
   * A callback rather than a node so the preview still knows nothing about masks.
   */
  readonly overlay?: (picture: { readonly width: number; readonly height: number }) => ReactNode;
  /**
   * The masks an effect may be bound to, and where to find each one's frame.
   *
   * A lookup rather than a map of every frame: a propagated mask is one entry per frame of a clip, and
   * handing the whole set to the preview on every render would copy thousands of run-length arrays to
   * find the one being drawn.
   */
  readonly masks?: MaskSource | undefined;
  /**
   * The effects available to draw with, project-local ones included.
   *
   * Supplied rather than built here. This used to construct its own registry from the builtins alone,
   * as the export did, so an effect living in the project's `effects/` folder was loaded, listed in the
   * inspector, and drawn by neither path — a feature that existed everywhere except on screen.
   */
  readonly effects: EffectRegistry;
}

export function Preview({
  document: doc,
  frame,
  sidecar,
  resolveAsset,
  overlay,
  masks,
  effects,
}: PreviewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [picture, setPicture] = useState<{ width: number; height: number } | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [panning, setPanning] = useState(false);
  /*
   * The box the picture is panned within, so a drag cannot carry it off the panel.
   *
   * Read from the stage rather than stored: the panel is resizable, and a bound computed once would
   * let the picture escape the moment the window changed.
   */
  const stage = {
    width: stageRef.current?.clientWidth ?? 0,
    height: stageRef.current?.clientHeight ?? 0,
  };
  const zoom = usePreviewZoom(stage);
  const compositorRef = useRef<GlCompositor | undefined>(undefined);
  const [stats, setStats] = useState<RenderStats | undefined>(undefined);
  /** Items the plan carried, so "nothing is visible" can be told apart from "nothing was planned". */
  const [planned, setPlanned] = useState(0);
  /** The spec's §8 pass budget, as a sentence, or absent while the frame is within it. */
  const [passBudget, setPassBudget] = useState<string | undefined>(undefined);
  const [textProblems, setTextProblems] = useState<readonly { clip: string; detail: string }[]>([]);
  const [glError, setGlError] = useState<string | undefined>(undefined);

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

    void prepareFrame(media, {
      document: doc,
      frame,
      effects,
      ...(masks !== undefined ? { masks } : {}),
    }).then(({ plan, textProblems: problems }) => {
      setTextProblems(problems);
      const current = compositorRef.current;
      if (current === undefined) return;
      setPlanned(plan.items.length);
      setPassBudget(passBudgetNote(plan));
      setStats(current.render(plan, null));
    });
  }, [doc, frame, effects, media, masks]);

  // The picture's own rectangle, which `object-fit: contain` decides and nothing can read back off
  // the element. Measured rather than derived from a stored layout, because the panel is resizable
  // and a stale rectangle would put every mask point a few pixels out with no sign that it had.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === undefined || canvas === null) return;
    if (globalThis.ResizeObserver === undefined) return;

    const measure = (): void => {
      /*
       * `offsetWidth`, not `getBoundingClientRect`.
       *
       * The two agreed until the picture could be zoomed: a rect is the *transformed* box, so at 2×
       * it reports twice the size — and the overlay, which is drawn at this size and sits inside the
       * same transformed element, would then be scaled twice. Layout units are the honest measurement
       * here, and they are what the transform is applied to.
       */
      const width = canvas.offsetWidth;
      const height = canvas.offsetHeight;
      if (width === 0 || height === 0) {
        setPicture(undefined);
        return;
      }
      setPicture(containedSize(width, height, doc.resolution.width, doc.resolution.height));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [doc.resolution.height, doc.resolution.width]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/50">
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
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onWheel={(event) => {
          // Held modifier, because an unmodified wheel over the preview is how a trackpad user
          // scrolls the panel it sits in, and stealing that would be worse than having no zoom.
          if (!event.ctrlKey && !event.metaKey) return;
          zoom.zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        }}
        onPointerDown={(event) => {
          // The middle button, which nothing else here claims. The primary one places mask points and
          // the secondary opens menus, so panning with either would take a gesture that already means
          // something on the very panel where masks are drawn.
          if (event.button !== 1) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setPanning(true);
        }}
        onPointerMove={(event) => {
          if (!panning) return;
          zoom.panBy(event.movementX, event.movementY);
        }}
        onPointerUp={() => setPanning(false)}
        onPointerCancel={() => setPanning(false)}
        onDoubleClick={() => zoom.reset()}
      >
        <div
          className="absolute inset-0"
          style={{
            // One transform over both, so the overlay cannot drift from the picture it annotates.
            transform: `translate(${zoom.panX}px, ${zoom.panY}px) scale(${zoom.scale})`,
            cursor: panning ? 'grabbing' : undefined,
          }}
        >
          <canvas
            ref={canvasRef}
            aria-label="Preview"
            // Black, and deliberately not a theme role: this is the letterbox around a picture, and a
            // preview whose surround changed with the theme would misreport what the frame looks like.
            className="absolute inset-3 h-[calc(100%-24px)] w-[calc(100%-24px)] bg-black object-contain"
          />

          {overlay !== undefined && picture !== undefined && (
            // Centred over the canvas at the picture's own size, which is what `object-fit: contain`
            // produces. Sharing the canvas's inset rather than guessing at where it sits is what keeps
            // a placed point on the pixel it was placed on.
            <div className="absolute inset-3 grid place-items-center">{overlay(picture)}</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 px-3 py-1 font-mono text-xs text-muted-foreground">
        {glError !== undefined && (
          <span className="flex items-center gap-1.5 text-destructive">
            <CircleAlertIcon className="size-3.5" />
            {glError}
          </span>
        )}
        {glError === undefined && (
          <>
            <span>{`frame ${frame}`}</span>
            {/* What the panel is showing the frame at. The word `fit` is what separates "this is all
                the room there is" from "you asked for this" — without it a user who has never touched
                the zoom reads 68% as something they did. */}
            {describeZoom(picture?.width, doc.resolution.width, zoom.scale) !== undefined && (
              <span>{describeZoom(picture?.width, doc.resolution.width, zoom.scale)}</span>
            )}
            <span>{`${planned} layers`}</span>
            <span>{`${stats?.passesExecuted ?? 0} passes`}</span>
            {/* Skipped layers are reported rather than hidden: a black preview with no explanation is
                indistinguishable from a broken one. */}
            {(stats?.layersSkipped ?? 0) > 0 && (
              <span className="flex items-center gap-1.5">
                <TriangleAlertIcon className="size-3.5" />
                {`${stats?.layersSkipped} layers still decoding`}
              </span>
            )}
            {/*
              A warning rather than an error, which is what §8 asks for: a heavy stack is a legitimate
              choice on a short clip. It sits beside the pass count it is about, so the number and the
              judgement on it are read together.
            */}
            {passBudget !== undefined && (
              <span className="flex items-center gap-1.5 text-amber-500">
                <TriangleAlertIcon className="size-3.5" />
                {passBudget}
              </span>
            )}
            {textProblems.length > 0 && (
              <span className="flex items-center gap-1.5 text-destructive">
                <CircleAlertIcon className="size-3.5" />
                {`title: ${textProblems[0]?.detail ?? ''}`}
              </span>
            )}
            {(stats?.passthroughs.length ?? 0) > 0 && (
              <span className="text-destructive flex items-center gap-1.5">
                <CircleAlertIcon className="size-3.5 shrink-0" />
                {/*
                  Issue #36: this said "1 effects failed to compile" and stopped there. The count is
                  the one thing the user already knows — the picture is wrong — and it withholds the
                  two things they need: *which* effect, and *why*. The describer that names both
                  already existed and was used everywhere except here.

                  The first one, in full, plus a count of the rest. Three stacked messages would push
                  the frame off the top of the strip, and fixing the first is usually what makes the
                  others make sense.
                */}
                {describeShaderError(stats!.passthroughs[0]!)}
                {(stats?.passthroughs.length ?? 0) > 1
                  ? ` · and ${(stats?.passthroughs.length ?? 1) - 1} more`
                  : ''}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The rectangle a picture of a given aspect fills inside a box, letterboxed.
 *
 * The same arithmetic `object-fit: contain` does, exported so it can be checked against the cases
 * that matter: a wide frame in a tall box, a tall frame in a wide box, and an exact match. Getting
 * it wrong does not look broken — it places mask points a few percent off, which reads as the
 * segmentation engine being inaccurate.
 */
export function containedSize(
  boxWidth: number,
  boxHeight: number,
  contentWidth: number,
  contentHeight: number,
): { readonly width: number; readonly height: number } {
  if (contentWidth <= 0 || contentHeight <= 0) return { width: boxWidth, height: boxHeight };
  const scale = Math.min(boxWidth / contentWidth, boxHeight / contentHeight);
  return { width: contentWidth * scale, height: contentHeight * scale };
}
