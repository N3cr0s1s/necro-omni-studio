import type { MaskId, Resolution, TypewriterCut } from '@nos/core';
import type {
  EffectPass,
  LayerSource,
  RenderLayer,
  RenderPlan,
  TransitionPass,
  UniformValue,
} from '../contracts/render-plan.js';
import type { ProgramCache, ShaderCompileError } from '../contracts/effect-source.js';
import { type BuiltinPrograms, type GlProgram } from './program-cache.js';
import { type RenderTarget, type RenderTargetPool, createPingPong } from './render-target.js';

/**
 * Supplies textures for layer sources and masks.
 *
 * Behind an interface because the sources are wildly different — a decoded video frame from a
 * `VideoFrame`/`<video>`, a rasterized text canvas, a cached mask PNG — and each has its own lifetime
 * and caching rules. The compositor only needs "give me a texture for this"; keeping decode policy out
 * of the render loop is what lets the preview and the export use different strategies (realtime
 * decode versus frame-exact seeking) behind one executor.
 */
export interface TextureProvider {
  /**
   * Texture for a layer source at the plan's frame.
   *
   * `undefined` means the frame is not yet available. The compositor then skips the layer rather than
   * stalling: a preview that drops a not-yet-decoded layer stays responsive, whereas one that blocks
   * turns a slow decode into a frozen UI.
   */
  textureFor(source: LayerSource): WebGLTexture | undefined;
  /** Texture for a cached mask, or `undefined` if it has not been generated yet. */
  maskTexture(mask: MaskId): WebGLTexture | undefined;
  /**
   * How much of a text layer to draw, for the typewriter's quad cut.
   *
   * Returned as plain texture coordinates rather than as anything the compositor could interpret,
   * which is the point: the provider owns the rasterizer and knows where each character ends, and the
   * compositor stays ignorant of fonts. `undefined` — for every non-text layer, and for text that is
   * fully revealed — means draw the layer whole.
   *
   * Optional so a provider written before the typewriter existed still satisfies the interface, and
   * so the harnesses that stub this out do not have to answer a question they have no fonts for.
   */
  revealCut?(source: LayerSource): TypewriterCut | undefined;
}

export interface RenderStats {
  /** Passes actually executed, which excludes any that fell back to passthrough. */
  readonly passesExecuted: number;
  /** Layers skipped because their texture was not ready. */
  readonly layersSkipped: number;
  /** Effects that degraded to passthrough this frame. */
  readonly passthroughs: readonly ShaderCompileError[];
}

export interface GlCompositor {
  /**
   * Renders a plan into a framebuffer.
   *
   * `destination` of `null` targets the default framebuffer, which is what preview does. Export passes
   * its own target and reads the pixels back.
   */
  render(plan: RenderPlan, destination: WebGLFramebuffer | null): RenderStats;
  dispose(): void;
}

export interface GlCompositorOptions {
  readonly gl: WebGL2RenderingContext;
  readonly programs: ProgramCache<GlProgram>;
  readonly builtins: BuiltinPrograms;
  readonly pool: RenderTargetPool;
  readonly textures: TextureProvider;
}

/**
 * The WebGL2 executor.
 *
 * Consumes a plan and issues draw calls. Deliberately the *only* part of the render pipeline that
 * touches GL: everything about what to draw was decided by the plan builder, so this file has no
 * knowledge of clips, keyframes, tracks or time. That split is what makes preview and export share one
 * implementation — they differ only in the destination framebuffer and the texture provider.
 */
export function createGlCompositor(options: GlCompositorOptions): GlCompositor {
  const { gl, programs, builtins, pool, textures } = options;

  /** Draws the fullscreen triangle. No attributes, so no VAO state to manage. */
  function drawFullscreen(): void {
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function bindTarget(target: RenderTarget | null, resolution: Resolution): void {
    if (target === null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, resolution.width, resolution.height);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
  }

  function setUniform(program: GlProgram, name: string, value: UniformValue): void {
    const location = program.uniforms.get(name);
    // Absent means the compiler stripped an unused uniform. Skipping is correct: it is not an error to
    // have a document parameter the current shader ignores.
    if (location === undefined) return;

    switch (value.kind) {
      case 'float':
        gl.uniform1f(location, value.value);
        break;
      case 'int':
        gl.uniform1i(location, value.value);
        break;
      case 'bool':
        gl.uniform1i(location, value.value ? 1 : 0);
        break;
      case 'vec2':
        gl.uniform2f(location, value.value[0], value.value[1]);
        break;
      case 'vec4':
        gl.uniform4f(location, value.value[0], value.value[1], value.value[2], value.value[3]);
        break;
      default: {
        const unreachable: never = value;
        throw new Error(`Unhandled uniform ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** Sets the four uniforms the spec guarantees every effect can read. */
  function setBuiltins(
    program: GlProgram,
    resolution: Resolution,
    timeSeconds: number,
    layer: RenderLayer | undefined,
  ): void {
    setUniform(program, 'u_resolution', {
      kind: 'vec2',
      value: [resolution.width, resolution.height],
    });
    setUniform(program, 'u_time', { kind: 'float', value: timeSeconds });
    setUniform(program, 'u_clip_time', {
      kind: 'float',
      value: layer?.clipTimeSeconds ?? timeSeconds,
    });
    setUniform(program, 'u_clip_length', {
      kind: 'float',
      value: layer?.clipLengthSeconds ?? 0,
    });
  }

  /**
   * Binds a texture to each of a program's sampler slots.
   *
   * Unit assignment follows the program's declared sampler order, so it is deterministic and matches
   * what `collectUniforms` found. A slot with no supplied texture is left bound to unit 0's texture
   * rather than unbound — sampling an unbound texture is undefined behaviour on some drivers and
   * produces garbage rather than black.
   */
  function bindSamplers(
    program: GlProgram,
    supplied: ReadonlyMap<string, WebGLTexture>,
    fallback: WebGLTexture,
  ): void {
    program.samplers.forEach((name, unit) => {
      const location = program.uniforms.get(name);
      if (location === undefined) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, supplied.get(name) ?? fallback);
      gl.uniform1i(location, unit);
    });
  }

  /**
   * Runs a layer's effect chain, returning the target holding the result.
   *
   * The ping-pong pair is borrowed for the duration and one half is returned to the pool; the caller
   * releases the survivor. An effect whose program failed to compile is *skipped* rather than drawn —
   * that is the spec's passthrough behaviour, and skipping is exactly equivalent to running a
   * passthrough shader while costing one fewer pass.
   */
  function renderLayerChain(
    layer: RenderLayer,
    sourceTexture: WebGLTexture,
    plan: RenderPlan,
    stats: { passesExecuted: number; passthroughs: ShaderCompileError[] },
  ): RenderTarget {
    let pingPong = createPingPong(pool.acquire(plan.resolution), pool.acquire(plan.resolution));

    // Seed the chain by copying the source into the first target, so a layer with no effects still
    // yields a target the compositor can sample uniformly.
    bindTarget(pingPong.read, plan.resolution);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    /*
     * A title mid-typewriter is cut here, in the seed, rather than in a pass of its own: the copy
     * happens for every layer anyway, so the reveal is free, and doing it *before* the effect chain is
     * what makes a glow light up the characters that have been typed rather than the whole line.
     */
    const cut = textures.revealCut?.(layer.source);
    const seed = cut === undefined ? builtins.passthrough : builtins.reveal;
    gl.useProgram(seed.program);
    bindSamplers(seed, new Map([['source', sourceTexture]]), sourceTexture);
    if (cut !== undefined) {
      setUniform(seed, 'u_reveal_done_v', { kind: 'float', value: cut.doneV });
      setUniform(seed, 'u_reveal_line_v', { kind: 'vec2', value: [cut.lineV[0], cut.lineV[1]] });
      setUniform(seed, 'u_reveal_line_u', { kind: 'float', value: cut.lineU });
    }

    gl.disable(gl.BLEND);
    drawFullscreen();

    for (const pass of layer.passes) {
      const slot = programs.get(pass.effect);
      if (slot.status !== 'ready') {
        stats.passthroughs.push(slot.error);
        continue;
      }

      const program = slot.program;
      bindTarget(pingPong.write, plan.resolution);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program.program);

      const supplied = new Map<string, WebGLTexture>([['source', pingPong.read.texture]]);
      const maskTexture = resolveMask(pass);
      if (maskTexture !== undefined) supplied.set('mask', maskTexture);

      bindSamplers(program, supplied, pingPong.read.texture);
      setBuiltins(program, plan.resolution, plan.timeSeconds, layer);
      for (const [name, value] of Object.entries(pass.uniforms)) {
        setUniform(program, name, value);
      }

      drawFullscreen();
      stats.passesExecuted += 1;
      pingPong = pingPong.swap();
    }

    // The result is in `read` after the final swap. The other half goes back to the pool.
    pool.release(pingPong.write);
    return pingPong.read;
  }

  function resolveMask(pass: EffectPass): WebGLTexture | undefined {
    return pass.mask === undefined ? undefined : textures.maskTexture(pass.mask);
  }

  /**
   * Composites a rendered layer onto the accumulator with its transform and opacity.
   *
   * Standard source-over blending with premultiply-free inputs: `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` for
   * colour and `ONE, ONE_MINUS_SRC_ALPHA` for alpha. Using the same factors for alpha would produce a
   * composite whose alpha is wrong wherever layers overlap, which only shows up when exporting with an
   * alpha channel — long after the preview looked fine.
   */
  function compositeOnto(
    accumulator: RenderTarget | null,
    layerTarget: RenderTarget,
    layer: RenderLayer,
    plan: RenderPlan,
  ): void {
    bindTarget(accumulator, plan.resolution);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const program = builtins.composite;
    gl.useProgram(program.program);
    bindSamplers(program, new Map([['source', layerTarget.texture]]), layerTarget.texture);

    setUniform(program, 'u_offset', {
      kind: 'vec2',
      value: [layer.transform.x, layer.transform.y],
    });
    setUniform(program, 'u_scale', { kind: 'float', value: layer.transform.scale });
    // Degrees in the document, radians in the shader: the conversion belongs at the boundary so the
    // document stays human-readable and the shader stays idiomatic.
    setUniform(program, 'u_rotation', {
      kind: 'float',
      value: (layer.transform.rotation * Math.PI) / 180,
    });
    setUniform(program, 'u_layer_opacity', {
      kind: 'float',
      value: layer.transform.opacity,
    });
    setUniform(program, 'u_resolution', {
      kind: 'vec2',
      value: [plan.resolution.width, plan.resolution.height],
    });

    drawFullscreen();
    gl.disable(gl.BLEND);
  }

  /**
   * Combines two rendered layers through a transition.
   *
   * Both sides are rendered with their own effect stacks first, then blended. Doing it the other way —
   * blending raw sources and then grading — would make a transition show material that matches neither
   * clip as it appears alone.
   */
  function renderTransition(
    transition: TransitionPass,
    fromTarget: RenderTarget,
    toTarget: RenderTarget,
    plan: RenderPlan,
    layer: RenderLayer,
    stats: { passesExecuted: number; passthroughs: ShaderCompileError[] },
  ): RenderTarget | undefined {
    const slot = programs.get(transition.effect);
    if (slot.status !== 'ready') {
      stats.passthroughs.push(slot.error);
      return undefined;
    }

    const target = pool.acquire(plan.resolution);
    bindTarget(target, plan.resolution);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    const program = slot.program;
    gl.useProgram(program.program);
    bindSamplers(
      program,
      new Map([
        ['from', fromTarget.texture],
        ['to', toTarget.texture],
      ]),
      fromTarget.texture,
    );

    setBuiltins(program, plan.resolution, plan.timeSeconds, layer);
    setUniform(program, 'progress', { kind: 'float', value: transition.progress });
    for (const [name, value] of Object.entries(transition.uniforms)) {
      setUniform(program, name, value);
    }

    drawFullscreen();
    stats.passesExecuted += 1;
    return target;
  }

  return {
    render(plan: RenderPlan, destination: WebGLFramebuffer | null): RenderStats {
      const stats = { passesExecuted: 0, layersSkipped: 0, passthroughs: [] as ShaderCompileError[] };

      // Everything composites into an offscreen accumulator and is blitted at the end. Compositing
      // straight to the destination would make the result depend on whatever was already there, and
      // for export that is an uninitialized buffer.
      const accumulator = pool.acquire(plan.resolution);
      bindTarget(accumulator, plan.resolution);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      for (const item of plan.items) {
        if (item.kind === 'layer') {
          const texture = textures.textureFor(item.layer.source);
          if (texture === undefined) {
            stats.layersSkipped += 1;
            continue;
          }
          const rendered = renderLayerChain(item.layer, texture, plan, stats);
          compositeOnto(accumulator, rendered, item.layer, plan);
          pool.release(rendered);
          continue;
        }

        const { from, to, transition } = item.group;
        const fromTexture = textures.textureFor(from.source);
        const toTexture = textures.textureFor(to.source);
        if (fromTexture === undefined || toTexture === undefined) {
          stats.layersSkipped += 1;
          continue;
        }

        const fromTarget = renderLayerChain(from, fromTexture, plan, stats);
        const toTarget = renderLayerChain(to, toTexture, plan, stats);
        const blended = renderTransition(transition, fromTarget, toTarget, plan, from, stats);

        // A broken transition falls back to the outgoing clip, so the picture never disappears.
        compositeOnto(accumulator, blended ?? fromTarget, from, plan);

        if (blended !== undefined) pool.release(blended);
        pool.release(fromTarget);
        pool.release(toTarget);
      }

      // Blit the accumulator to the destination.
      bindTarget(null, plan.resolution);
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
      gl.viewport(0, 0, plan.resolution.width, plan.resolution.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(builtins.passthrough.program);
      bindSamplers(builtins.passthrough, new Map([['source', accumulator.texture]]), accumulator.texture);
      drawFullscreen();

      pool.release(accumulator);
      return stats;
    },

    dispose(): void {
      programs.dispose();
      builtins.dispose();
      pool.dispose();
    },
  };
}
