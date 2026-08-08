import type { EffectId, Result } from '@nos/core';

/**
 * What the compositor needs to know about an effect.
 *
 * Deliberately *not* the effect manifest type. The manifest is the registry's concern and will grow
 * fields the renderer does not care about; the compositor needs only the shader, its samplers, its
 * uniform names and whether it follows the gl-transitions convention. Keeping the dependency this
 * narrow is what lets the effect registry (Phase 4) evolve without touching the render path.
 */

export type EffectCategory = 'effect' | 'transition';

/** GLSL types a parameter uniform can have. */
export type EffectUniformType = 'float' | 'int' | 'bool' | 'vec2' | 'vec4';

/**
 * A parameter uniform.
 *
 * The type is required, not optional: the wrapper *declares* these in the generated shader, so an
 * effect author writes `u_amount` in their body without a `uniform float u_amount;` line. Without the
 * type there is nothing to declare, and the shader fails with "undeclared identifier".
 */
export interface EffectUniformDeclaration {
  /** GLSL uniform name, e.g. `u_amount`. */
  readonly name: string;
  readonly type: EffectUniformType;
  /**
   * Document parameter key feeding this uniform, e.g. `amount`.
   *
   * The manifest format in `interfaces.md` §4 gives a parameter both a `key` and a `uniform`, and they
   * routinely differ — the document reads `amount` while the shader declares `u_amount`. Conflating
   * them silently drops every parameter whose two names disagree, which presents as an effect that
   * renders but ignores its controls. Defaults to `name` when a manifest uses one spelling for both.
   */
  readonly paramKey?: string;
}

/** The document key that feeds a uniform. */
export function paramKeyOf(uniform: EffectUniformDeclaration): string {
  return uniform.paramKey ?? uniform.name;
}

/** Declared sampler slots, in binding order. `source`, or `from`/`to` for a transition. */
export interface EffectShaderSource {
  readonly id: EffectId;
  readonly category: EffectCategory;
  /** The fragment shader body as authored. */
  readonly source: string;
  readonly samplers: readonly string[];
  /**
   * When set, the compositor generates the standard wrapper so an unmodified gl-transitions shader
   * compiles as-is. The spec requires that library's shaders to be usable by copy-paste.
   *
   * Implies `declaresOwnUniforms`: that library's shaders carry their own `uniform` lines, and
   * re-declaring one is a compile error.
   */
  readonly convention?: 'gl-transitions';
  /** Uniform name carrying transition progress. Defaults to `progress`. */
  readonly progressUniform?: string;
  /**
   * Parameter uniforms the effect exposes.
   *
   * Used for two things: generating the declarations, and filtering out stale document parameters the
   * shader no longer has.
   */
  readonly uniforms: readonly EffectUniformDeclaration[];
  /**
   * Set when the authored source declares its own `uniform` lines.
   *
   * The wrapper then skips generating them, because a duplicate declaration is a compile error. Only
   * relevant for shaders written against another convention; effects authored for this app rely on
   * the generated declarations.
   */
  readonly declaresOwnUniforms?: boolean;
}

/** Uniform names, for the plan builder's parameter filter. */
export function uniformNames(effect: EffectShaderSource): readonly string[] {
  return effect.uniforms.map((uniform) => uniform.name);
}

/**
 * Resolves an effect id to what the compositor needs.
 *
 * An interface so the render path can be tested with a handful of inline shaders, and so a
 * project-local effect folder, a built-in set and a future remote library are all just different
 * resolvers.
 */
export interface EffectSourceResolver {
  resolve(id: EffectId): EffectShaderSource | undefined;
}

export type ShaderCompileError =
  | {
      readonly kind: 'compile-failed';
      readonly effect: EffectId;
      readonly stage: 'vertex' | 'fragment';
      /** Raw driver log, kept verbatim: it names the line, which is what the user needs. */
      readonly log: string;
      /** Parsed diagnostics, for rendering the error against the source. */
      readonly diagnostics: readonly ShaderDiagnostic[];
    }
  | { readonly kind: 'link-failed'; readonly effect: EffectId; readonly log: string }
  | { readonly kind: 'not-found'; readonly effect: EffectId }
  | { readonly kind: 'context-lost' };

export interface ShaderDiagnostic {
  /** 1-based line in the *authored* source, with the generated preamble subtracted. */
  readonly line: number;
  readonly column?: number;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

export function describeShaderError(error: ShaderCompileError): string {
  switch (error.kind) {
    case 'compile-failed': {
      const first = error.diagnostics[0];
      const where = first === undefined ? '' : ` at line ${first.line}`;
      return `${error.effect} failed to compile${where}: ${first?.message ?? error.log}`;
    }
    case 'link-failed':
      return `${error.effect} failed to link: ${error.log}`;
    case 'not-found':
      return `Effect ${error.effect} is not in the registry`;
    case 'context-lost':
      return 'The graphics context was lost';
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled shader error ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * A compiled program, or the reason it could not be built.
 *
 * The spec is explicit that a shader compile error puts the effect into **passthrough** mode and
 * that neither preview nor export stops. So a failure is a first-class state carried alongside the
 * slot rather than an exception: the pass is skipped, the error is shown in the clip inspector, and
 * everything else renders.
 */
export type ProgramSlot<TProgram> =
  | { readonly status: 'ready'; readonly program: TProgram }
  | { readonly status: 'passthrough'; readonly error: ShaderCompileError };

export function isReady<TProgram>(
  slot: ProgramSlot<TProgram>,
): slot is { status: 'ready'; program: TProgram } {
  return slot.status === 'ready';
}

/** Compiles and caches shader programs. */
export interface ProgramCache<TProgram> {
  /**
   * Returns the program for an effect, compiling on first use.
   *
   * Never throws for a bad shader — that is what `ProgramSlot` is for.
   */
  get(id: EffectId): ProgramSlot<TProgram>;
  /** Every effect that failed, for the inspector's error list. */
  failures(): readonly ShaderCompileError[];
  /** Drops a cached program so an edited shader recompiles. */
  invalidate(id: EffectId): void;
  dispose(): void;
}

/** Result alias used by executors that need to surface a fatal setup failure. */
export type CompositorResult<T> = Result<T, ShaderCompileError>;
