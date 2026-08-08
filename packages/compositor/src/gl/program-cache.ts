import type { EffectId } from '@nos/core';
import {
  type EffectShaderSource,
  type EffectSourceResolver,
  type ProgramCache,
  type ProgramSlot,
  type ShaderCompileError,
} from '../contracts/effect-source.js';
import {
  COMPOSITE_FRAGMENT_SHADER,
  FULLSCREEN_VERTEX_SHADER,
  PASSTHROUGH_FRAGMENT_SHADER,
  assembleFragmentShader,
  parseShaderLog,
} from '../shader/shader-source.js';

/**
 * Compiled program with its uniform locations resolved once.
 *
 * Locations are looked up at link time rather than per draw. `getUniformLocation` is a string lookup
 * that crosses into the driver; doing it for every uniform of every pass of every layer at 30 fps is a
 * measurable cost for something that never changes after linking.
 */
export interface GlProgram {
  readonly program: WebGLProgram;
  readonly uniforms: ReadonlyMap<string, WebGLUniformLocation>;
  /** Sampler names in binding order, so texture units are assigned deterministically. */
  readonly samplers: readonly string[];
  /** Lines the wrapper prepended, for rebasing diagnostics. */
  readonly preambleLines: number;
}

/**
 * Program cache with passthrough fallback.
 *
 * The spec requires a shader compile error to degrade the effect to passthrough and leave both preview
 * and export running. So compilation failure is recorded and returned as a `passthrough` slot rather
 * than thrown — a typo in a shader must cost the user that one effect, not their render.
 */
export function createProgramCache(
  gl: WebGL2RenderingContext,
  effects: EffectSourceResolver,
): ProgramCache<GlProgram> {
  const cache = new Map<string, ProgramSlot<GlProgram>>();
  const compiled = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER);

  if (!compiled.ok) {
    // The shared vertex shader failing means the context is unusable, not that one effect is broken —
    // so unlike a fragment failure this throws rather than degrading to passthrough.
    throw new Error(`the shared vertex shader failed to compile: ${compiled.log}`);
  }

  // Bound outside the closure: a narrowing from the guard above does not survive into a nested
  // function, and re-checking inside would imply the failure is recoverable there.
  const vertexShader: WebGLShader = compiled.shader;

  function buildSlot(id: EffectId): ProgramSlot<GlProgram> {
    const source = effects.resolve(id);
    if (source === undefined) {
      return { status: 'passthrough', error: { kind: 'not-found', effect: id } };
    }
    return linkEffect(gl, vertexShader, source);
  }

  return {
    get(id: EffectId): ProgramSlot<GlProgram> {
      const existing = cache.get(id);
      if (existing !== undefined) return existing;
      const slot = buildSlot(id);
      cache.set(id, slot);
      return slot;
    },

    failures(): readonly ShaderCompileError[] {
      const errors: ShaderCompileError[] = [];
      for (const slot of cache.values()) {
        if (slot.status === 'passthrough') errors.push(slot.error);
      }
      return errors;
    },

    invalidate(id: EffectId): void {
      const slot = cache.get(id);
      if (slot?.status === 'ready') gl.deleteProgram(slot.program.program);
      cache.delete(id);
    },

    dispose(): void {
      for (const slot of cache.values()) {
        if (slot.status === 'ready') gl.deleteProgram(slot.program.program);
      }
      cache.clear();
      gl.deleteShader(vertexShader);
    },
  };
}

type CompileResult =
  | { readonly ok: true; readonly shader: WebGLShader }
  | { readonly ok: false; readonly log: string };

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): CompileResult {
  const shader = gl.createShader(type);
  if (shader === null) return { ok: false, log: 'could not create a shader object' };

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    // Drivers null-terminate the log; leaving it in corrupts the message when displayed.
    const log = (gl.getShaderInfoLog(shader) ?? '').replace(/\0/g, '');
    gl.deleteShader(shader);
    return { ok: false, log };
  }

  return { ok: true, shader };
}

function linkEffect(
  gl: WebGL2RenderingContext,
  vertexShader: WebGLShader,
  source: EffectShaderSource,
): ProgramSlot<GlProgram> {
  const assembled = assembleFragmentShader(source);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, assembled.source);

  if (!fragment.ok) {
    return {
      status: 'passthrough',
      error: {
        kind: 'compile-failed',
        effect: source.id,
        stage: 'fragment',
        log: fragment.log,
        diagnostics: parseShaderLog(fragment.log, assembled.preambleLines),
      },
    };
  }

  const program = gl.createProgram();
  if (program === null) {
    gl.deleteShader(fragment.shader);
    return {
      status: 'passthrough',
      error: { kind: 'link-failed', effect: source.id, log: 'could not create a program' },
    };
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragment.shader);
  gl.linkProgram(program);

  // The fragment shader is no longer needed once linked; the program holds its own copy.
  gl.deleteShader(fragment.shader);

  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = (gl.getProgramInfoLog(program) ?? '').replace(/\0/g, '');
    gl.deleteProgram(program);
    return { status: 'passthrough', error: { kind: 'link-failed', effect: source.id, log } };
  }

  return {
    status: 'ready',
    program: {
      program,
      uniforms: collectUniforms(gl, program),
      samplers: assembled.samplers,
      preambleLines: assembled.preambleLines,
    },
  };
}

/**
 * Collects every active uniform location after linking.
 *
 * Array uniforms are reported by the driver as `name[0]`; both spellings are stored so a caller can use
 * either. Inactive uniforms — declared but unused, which the compiler strips — are simply absent, and
 * setting one is a no-op rather than an error.
 */
function collectUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): ReadonlyMap<string, WebGLUniformLocation> {
  const uniforms = new Map<string, WebGLUniformLocation>();
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;

  for (let index = 0; index < count; index += 1) {
    const info = gl.getActiveUniform(program, index);
    if (info === null) continue;
    const location = gl.getUniformLocation(program, info.name);
    if (location === null) continue;

    uniforms.set(info.name, location);
    if (info.name.endsWith('[0]')) {
      uniforms.set(info.name.slice(0, -3), location);
    }
  }

  return uniforms;
}

/**
 * The two programs the compositor always needs.
 *
 * `passthrough` is the fallback for a broken effect and the copy operation between targets;
 * `composite` draws a layer onto the accumulator with its transform and opacity.
 */
export interface BuiltinPrograms {
  readonly passthrough: GlProgram;
  readonly composite: GlProgram;
  dispose(): void;
}

export function createBuiltinPrograms(gl: WebGL2RenderingContext): BuiltinPrograms {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER);
  if (!vertex.ok) throw new Error(`built-in vertex shader failed: ${vertex.log}`);

  const build = (fragmentSource: string, samplers: readonly string[], label: string): GlProgram => {
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!fragment.ok) throw new Error(`built-in ${label} shader failed: ${fragment.log}`);

    const program = gl.createProgram();
    if (program === null) throw new Error(`could not create the built-in ${label} program`);

    gl.attachShader(program, vertex.shader);
    gl.attachShader(program, fragment.shader);
    gl.linkProgram(program);
    gl.deleteShader(fragment.shader);

    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      const log = (gl.getProgramInfoLog(program) ?? '').replace(/\0/g, '');
      gl.deleteProgram(program);
      throw new Error(`built-in ${label} program failed to link: ${log}`);
    }

    return {
      program,
      uniforms: collectUniforms(gl, program),
      samplers,
      preambleLines: 0,
    };
  };

  const passthrough = build(PASSTHROUGH_FRAGMENT_SHADER, ['source'], 'passthrough');
  const composite = build(COMPOSITE_FRAGMENT_SHADER, ['source'], 'composite');

  return {
    passthrough,
    composite,
    dispose(): void {
      gl.deleteProgram(passthrough.program);
      gl.deleteProgram(composite.program);
      gl.deleteShader(vertex.shader);
    },
  };
}
