import { type ReactNode, useEffect, useRef, useState } from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { effectId } from '@nos/core';
import {
  type CompileCheck,
  type EffectShaderSource,
  assembleFragmentShader,
  checkShader,
  describeCompileCheck,
} from '@nos/compositor';
import {
  type AnyEffectManifest,
  type EffectDraft,
  asEffectParam,
  effectFiles,
  toShaderSource,
  uniformOf,
} from '@nos/effects';
import { cn } from '@nos/ui/lib/utils';

/**
 * What the shader being written actually does, on a real frame.
 *
 * Issue #28 asks for a preview, and the reason it is the centre of an effect editor rather than a
 * nicety: GLSL has no useful feedback loop otherwise. Without it, authoring is edit, save, reload the
 * project, drag the effect onto a clip, look — a cycle long enough that people stop making small
 * changes, which is how shaders are actually written.
 *
 * ## A real context, and the compositor's own compile
 *
 * The frame is drawn by an actual WebGL2 context through `checkShader`, which assembles the source
 * exactly as the program cache does. So a shader that draws here is one the compositor accepts, and a
 * diagnostic here names the line the author is looking at. Anything cheaper — a regex, a heuristic,
 * a "looks fine" — would be a second opinion that eventually disagrees with the one that matters.
 *
 * ## Why a checkerboard and a gradient
 *
 * The test frame has to make an effect *visible*. A flat colour hides anything that varies with
 * position; a photograph hides anything subtle in the noise. Squares give edges and hard transitions,
 * the gradient gives every luminance from black to white, and the alpha corner shows what a shader
 * does to transparency — which is the thing most first drafts get wrong.
 */

export interface ShaderPreviewProps {
  readonly draft: EffectDraft;
  /** Reported upward so the editor can gate Save on it, rather than each deciding separately. */
  readonly onCompile?: (check: CompileCheck) => void;
}

/** The size the preview draws at. Small on purpose: it recompiles on every keystroke. */
const SIZE = 256;

export function ShaderPreview({ draft, onCompile }: ShaderPreviewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const gl = canvas.getContext('webgl2');
    if (gl === null) {
      setProblem('this build has no WebGL2 context, so the preview cannot draw');
      return;
    }

    const source = shaderSourceFor(draft);

    const check = checkShader(gl, source);
    onCompile?.(check);
    setProblem(describeCompileCheck(check));
    if (!check.ok) {
      // The last good frame is deliberately left on screen. Blanking it on every broken keystroke
      // makes the canvas flash black while someone types a function name, and takes away the very
      // thing they are comparing against.
      return;
    }

    drawPreview(gl, source, draft);
  }, [draft, onCompile]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Preview</span>
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        aria-label="Shader preview"
        // Checkered behind the canvas, so a shader that writes alpha reads as transparent rather than
        // as black — the two are indistinguishable on an opaque backdrop.
        className={cn(
          'border',
          '[background-image:repeating-conic-gradient(theme(colors.muted.DEFAULT)_0_25%,transparent_0_50%)]',
          '[background-size:16px_16px]',
        )}
      />
      {problem !== undefined && (
        <p className="text-destructive flex items-start gap-1.5 font-mono text-xs">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The draft as the compositor would see it.
 *
 * Through `toShaderSource`, which is what the registry uses, rather than assembled here — it is the
 * one place that knows a manifest's `color` is a `vec4` and that a transition declares its own
 * uniforms. A second mapping in this file would be a preview that is subtly not the effect.
 *
 * The id is only ever a label in a diagnostic, so an unnamed draft borrows one rather than refusing
 * to preview: someone writing a shader has not necessarily decided what to call it yet.
 */
function shaderSourceFor(draft: EffectDraft): EffectShaderSource {
  const base = {
    id: effectId(draft.id === '' ? 'preview' : draft.id),
    name: draft.name,
    // The shader is passed as text, so the filename this would name is not read. Written out anyway
    // rather than left blank, because `effectFiles` is the one place that decides it.
    shader: effectFiles(draft.id).shader,
    samplers: draft.samplers,
    params: draft.params.map(asEffectParam),
  };

  // Spelled as the union rather than cast: `as never` here would hide exactly the kind of mistake it
  // has hidden before in this repository — a field of the wrong shape reaching a function that reads
  // it and silently doing nothing.
  const manifest: AnyEffectManifest =
    draft.category === 'transition' ? { ...base, category: 'transition' } : { ...base, category: 'effect' };

  return toShaderSource(manifest, draft.shader);
}

/**
 * Compiles for real and draws one frame.
 *
 * Everything is created and destroyed per draw. That is wasteful and correct here: the draft changes
 * on every keystroke, the shader changes with it, and a cache keyed by a string that changes every
 * keystroke is a leak with extra steps. At 256×256 once per edit it is not measurable.
 */
function drawPreview(gl: WebGL2RenderingContext, source: EffectShaderSource, draft: EffectDraft): void {
  const program = buildProgram(gl, source);
  if (program === undefined) return;

  try {
    const texture = testFrame(gl);
    try {
      gl.viewport(0, 0, SIZE, SIZE);
      gl.useProgram(program);

      // Every declared sampler gets the same test frame. A transition reads `from` and `to`, and
      // giving both the same image shows the shape of the blend rather than a comparison of pictures.
      draft.samplers.forEach((sampler, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const location = gl.getUniformLocation(program, sampler);
        if (location !== null) gl.uniform1i(location, unit);
      });

      setUniforms(gl, program, draft);

      // A full-screen triangle from `gl_VertexID`, so there is no vertex buffer to create or leak.
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      gl.deleteTexture(texture);
    }
  } finally {
    gl.deleteProgram(program);
  }
}

/** Each parameter at its declared default, or the middle of its range, so the preview shows something. */
function setUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, draft: EffectDraft): void {
  for (const param of draft.params) {
    const location = gl.getUniformLocation(program, uniformOf(param));
    if (location === null) continue;

    const fallback = param.min !== undefined && param.max !== undefined ? (param.min + param.max) / 2 : 1;
    const value = param.default ?? fallback;

    switch (param.type) {
      case 'bool':
        gl.uniform1i(location, value === true || value === 1 ? 1 : 0);
        break;
      case 'int':
        gl.uniform1i(location, Math.round(Number(value)));
        break;
      case 'vec2': {
        const pair = Array.isArray(value) ? value : [Number(value), Number(value)];
        gl.uniform2f(location, Number(pair[0] ?? 0), Number(pair[1] ?? 0));
        break;
      }
      case 'color': {
        const rgba = Array.isArray(value) ? value : [1, 1, 1, 1];
        gl.uniform4f(
          location,
          Number(rgba[0] ?? 1),
          Number(rgba[1] ?? 1),
          Number(rgba[2] ?? 1),
          Number(rgba[3] ?? 1),
        );
        break;
      }
      default:
        gl.uniform1f(location, Number(value));
    }
  }
}

/** The vertex stage every pass here shares: a full-screen triangle with no attributes. */
const VERTEX_SHADER = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

function buildProgram(gl: WebGL2RenderingContext, source: EffectShaderSource): WebGLProgram | undefined {
  // Assembled by the compositor, so the preview compiles the same text a real pass does. `checkShader`
  // has already reported whether it compiles; this builds the program the frame is actually drawn with.
  const fragment = compile(gl, gl.FRAGMENT_SHADER, assembleFragmentShader(source).source);
  if (fragment === undefined) return undefined;

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  if (vertex === undefined) {
    gl.deleteShader(fragment);
    return undefined;
  }

  const program = gl.createProgram();
  try {
    if (program === null) return undefined;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    // A link failure with a fragment stage that compiled is the editor's problem, not the author's —
    // there is nothing they could change — so it draws nothing rather than reporting GLSL at them.
    return gl.getProgramParameter(program, gl.LINK_STATUS) === true ? program : undefined;
  } finally {
    // Detached by deletion: the program keeps them alive until it is itself deleted.
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | undefined {
  const shader = gl.createShader(type);
  if (shader === null) return undefined;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true) return shader;
  gl.deleteShader(shader);
  return undefined;
}

/**
 * A frame that makes an effect visible.
 *
 * Checkerboard for edges, a gradient for every luminance, and one transparent corner — the last
 * because what a shader does to alpha is the thing most first drafts get wrong, and a preview that
 * cannot show it hides the bug until the effect is on a clip.
 */
function testFrame(gl: WebGL2RenderingContext): WebGLTexture | null {
  const side = 64;
  const pixels = new Uint8Array(side * side * 4);

  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const at = (y * side + x) * 4;
      const square = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const ramp = Math.round((x / (side - 1)) * 255);

      pixels[at] = square ? ramp : 255 - ramp;
      pixels[at + 1] = ramp;
      pixels[at + 2] = square ? 255 - ramp : ramp;
      // The bottom-left quarter is transparent.
      pixels[at + 3] = x < side / 2 && y < side / 2 ? 0 : 255;
    }
  }

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, side, side, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}
