import type { EffectShaderSource, ShaderDiagnostic } from '../contracts/effect-source.js';
import { assembleFragmentShader, parseShaderLog } from './shader-source.js';

/**
 * Compiling a shader that is being written, to say what is wrong with it.
 *
 * Issue #28's editor needs an answer to one question — *does this compile, and if not, where?* — and
 * it has to be the **same** answer the application would give. So this goes through
 * `assembleFragmentShader` and `parseShaderLog`, exactly as the program cache does: the preamble it
 * adds is the preamble the real pass gets, and the reported line is the line in the author's file
 * rather than in the assembled source.
 *
 * A second, editor-only compile path would be worse than none. It would drift, and the day it did the
 * editor would call a shader good that the compositor then refused — with the user looking at a green
 * preview and a broken effect.
 *
 * ## Why only the fragment stage
 *
 * An effect author writes a fragment shader and nothing else; the vertex stage is the compositor's and
 * is the same for every pass. Linking is left to the program cache, which is where a real pass is
 * built — this exists to answer the question the author can act on.
 */

export type CompileCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: 'compile-failed' | 'unavailable';
      /** Empty when the driver said nothing structured; `log` always carries what it did say. */
      readonly diagnostics: readonly ShaderDiagnostic[];
      readonly log: string;
    };

/** The slice of WebGL2 this needs, so a caller can pass a real context or a fake one. */
export interface ShaderCompiler {
  createShader(type: number): WebGLShader | null;
  shaderSource(shader: WebGLShader, source: string): void;
  compileShader(shader: WebGLShader): void;
  getShaderParameter(shader: WebGLShader, pname: number): unknown;
  getShaderInfoLog(shader: WebGLShader): string | null;
  deleteShader(shader: WebGLShader | null): void;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
}

/**
 * Compiles the effect's fragment stage and reports what the driver said.
 *
 * The shader is always deleted, including when the compile succeeded: an editor recompiles on every
 * keystroke, and a leaked shader object per keystroke is a driver resource leak that shows up as the
 * editor getting slower the longer it is open.
 */
export function checkShader(gl: ShaderCompiler, effect: EffectShaderSource): CompileCheck {
  const assembled = assembleFragmentShader(effect);
  const shader = gl.createShader(gl.FRAGMENT_SHADER);

  // A context that will not make a shader is not a shader that will not compile, and telling the
  // author their GLSL is wrong would be a lie.
  if (shader === null) {
    return { ok: false, kind: 'unavailable', diagnostics: [], log: 'no graphics context' };
  }

  try {
    gl.shaderSource(shader, assembled.source);
    gl.compileShader(shader);

    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true) return { ok: true };

    const log = gl.getShaderInfoLog(shader) ?? '';
    return {
      ok: false,
      kind: 'compile-failed',
      // Offset by the preamble, so line 3 of the message is line 3 of what the author typed.
      diagnostics: parseShaderLog(log, assembled.preambleLines),
      log,
    };
  } finally {
    gl.deleteShader(shader);
  }
}

/**
 * One line for the editor to show.
 *
 * The first diagnostic rather than all of them: GLSL compilers cascade, and the second error is
 * usually the first one's consequence, so a wall of them buries the one line that matters. The rest
 * stay in `diagnostics` for a caller that wants to mark up the source.
 *
 * A line at or below zero is **not** in the author's file — `parseShaderLog` maps anything it cannot
 * place, and anything the driver reported inside the generated preamble, to line 0. Printing "line 0"
 * would send someone looking at a line that does not exist, so those are shown as the message alone.
 * The tests found this: a driver log of `out of memory` came back as `line 0: out of memory`.
 */
export function describeCompileCheck(check: CompileCheck): string | undefined {
  if (check.ok) return undefined;
  if (check.kind === 'unavailable') return 'the shader could not be compiled here — no graphics context';

  const first = check.diagnostics[0];
  if (first === undefined) return check.log.trim() === '' ? 'the shader did not compile' : check.log.trim();
  return first.line > 0 ? `line ${first.line}: ${first.message}` : first.message;
}
