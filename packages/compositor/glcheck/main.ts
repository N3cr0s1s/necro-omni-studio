/**
 * End-to-end GL verification harness.
 *
 * Runs the real executor against a real WebGL2 context and reads pixels back. Unit tests with a mocked
 * context can only assert that calls were made in some order; they cannot catch a wrong blend factor, an
 * incomplete framebuffer, a sampler bound to the wrong unit, or a ping-pong that reads its own output.
 * All of those are silent in a mock and visible in a pixel.
 *
 * Results are written to `window.__glcheck` for Playwright to collect.
 */
import {
  type EffectShaderSource,
  type EffectSourceResolver,
  type LayerSource,
  type RenderPlan,
  type TextureProvider,
  createBuiltinPrograms,
  createGlCompositor,
  createMaskTextureStore,
  createProgramCache,
  createRenderTargetPool,
  describeShaderError,
} from '../src/index.js';
import { clipId, effectId, effectInstanceId, frameIndex, maskId } from '@nos/core';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import { encodeRle, toRgba } from '@nos/masks';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true });
if (gl === null) throw new Error('no WebGL2');

// Half-float render targets need this extension for LINEAR filtering on some drivers; without it the
// framebuffer is incomplete and every draw silently disappears.
gl.getExtension('EXT_color_buffer_float');
gl.getExtension('OES_texture_float_linear');

const RESOLUTION = { width: 64, height: 64 };

/** A solid-colour 1x1 texture, standing in for a decoded frame. */
function solidTexture(r: number, g: number, b: number, a = 255): WebGLTexture {
  const texture = gl!.createTexture()!;
  gl!.bindTexture(gl!.TEXTURE_2D, texture);
  gl!.texImage2D(
    gl!.TEXTURE_2D,
    0,
    gl!.RGBA,
    1,
    1,
    0,
    gl!.RGBA,
    gl!.UNSIGNED_BYTE,
    new Uint8Array([r, g, b, a]),
  );
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
  return texture;
}

const RED = solidTexture(255, 0, 0);
const BLUE = solidTexture(0, 0, 255);
// Deliberately mid-grey, not white: a white mask cannot distinguish "the mask sampler is bound
// correctly" from "the mask sampler got the source texture", because red's own R channel is also 1.0.
// At 0.5 the two outcomes differ (128 versus 255).
const GREY_MASK = solidTexture(128, 128, 128);

const textures: TextureProvider = {
  textureFor(source: LayerSource): WebGLTexture | undefined {
    if (source.kind === 'video' || source.kind === 'image') {
      if (String(source.asset).includes('blue')) return BLUE;
      if (String(source.asset).includes('missing')) return undefined;
      return RED;
    }
    return RED;
  },
  maskTexture: () => GREY_MASK,
};

/** Effects exercising the paths that matter: a uniform, a mask sampler, a transition, a broken shader. */
const EFFECTS: Record<string, EffectShaderSource> = {
  // Swaps red and green channels, so a wrong result is obvious rather than subtle.
  swap_rg: {
    id: effectId('swap_rg'),
    category: 'effect',
    samplers: ['source'],
    uniforms: [{ name: 'u_mix', type: 'float' }],
    source: `void main() {
  vec4 c = texture(source, v_uv);
  fragColor = vec4(mix(c.r, c.g, u_mix), mix(c.g, c.r, u_mix), c.b, c.a);
}`,
  },
  // Multiplies by the mask, proving the mask slot is bound to the right unit.
  mask_mul: {
    id: effectId('mask_mul'),
    category: 'effect',
    samplers: ['source', 'mask'],
    uniforms: [],
    // Multiplies RGB only. Scaling alpha as well would additionally dim the composite blend, making the
    // read-back depend on two effects at once and the assertion ambiguous.
    source: `void main() {
  vec4 c = texture(source, v_uv);
  fragColor = vec4(c.rgb * texture(mask, v_uv).r, c.a);
}`,
  },
  // Halves the red channel; used twice to prove the ping-pong actually chains.
  half_red: {
    id: effectId('half_red'),
    category: 'effect',
    samplers: ['source'],
    uniforms: [],
    source: `void main() {
  vec4 c = texture(source, v_uv);
  fragColor = vec4(c.r * 0.5, c.g, c.b, c.a);
}`,
  },
  // Reads the built-in uniforms, proving they are set.
  builtin_probe: {
    id: effectId('builtin_probe'),
    category: 'effect',
    samplers: ['source'],
    uniforms: [],
    source: `void main() {
  fragColor = vec4(u_clip_time, u_clip_length, u_resolution.x / 255.0, 1.0);
}`,
  },
  broken: {
    id: effectId('broken'),
    category: 'effect',
    samplers: ['source'],
    uniforms: [],
    source: `void main() { this is not glsl }`,
  },
  wipe: {
    id: effectId('wipe'),
    category: 'transition',
    samplers: ['from', 'to'],
    convention: 'gl-transitions',
    uniforms: [],
    source: `vec4 transition(vec2 uv) {
  return mix(getFromColor(uv), getToColor(uv), step(uv.x, progress));
}`,
  },
};

const effects: EffectSourceResolver = { resolve: (id) => EFFECTS[id] };

/**
 * Compiles every shipped built-in effect.
 *
 * These are the effects a fresh install shows in its menu, so a syntax error in one is a defect every
 * user meets on first run. Verified here rather than trusted, for the same reason the wrapper is.
 */
const builtinResults = (() => {
  const registry = createEffectRegistry(BUILTIN_EFFECTS);
  return registry.available().map((entry) => {
    const slot = createProgramCache(gl!, registry).get(entry.id);
    return {
      id: entry.id,
      category: entry.manifest.category,
      compiled: slot.status === 'ready',
      error: slot.status === 'ready' ? undefined : describeShaderError(slot.error),
    };
  });
})();

const programs = createProgramCache(gl, effects);
const builtins = createBuiltinPrograms(gl);
const pool = createRenderTargetPool(gl);
const compositor = createGlCompositor({ gl, programs, builtins, pool, textures });

const layer = (
  asset: string,
  passes: RenderPlan['items'][number] extends never ? never : any[] = [],
  overrides: any = {},
) => ({
  clip: clipId(asset),
  source: { kind: 'video' as const, asset: asset as never, sourceFrame: frameIndex(0) },
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, ...overrides.transform },
  passes,
  clipTimeSeconds: overrides.clipTimeSeconds ?? 0,
  clipLengthSeconds: overrides.clipLengthSeconds ?? 1,
});

const pass = (effect: string, uniforms: Record<string, unknown> = {}, mask?: string) => ({
  instance: effectInstanceId(`i_${effect}`),
  effect: effectId(effect),
  uniforms,
  ...(mask === undefined ? {} : { mask: mask as never }),
});

function makePlan(items: unknown[], timeSeconds = 0): RenderPlan {
  return {
    frame: frameIndex(0),
    resolution: RESOLUTION,
    timeSeconds,
    items: items as RenderPlan['items'],
    passCount: 0,
  };
}

/** Renders a plan to the canvas and reads the centre pixel. */
function renderAndRead(plan: RenderPlan): { pixel: number[]; stats: unknown; glError: number } {
  const stats = compositor.render(plan, null);
  const pixels = new Uint8Array(4);
  gl!.readPixels(32, 32, 1, 1, gl!.RGBA, gl!.UNSIGNED_BYTE, pixels);
  return { pixel: [...pixels], stats, glError: gl!.getError() };
}

/** Reads one pixel of whatever was last rendered. */
function readAt(x: number, y: number): number[] {
  const pixels = new Uint8Array(4);
  gl!.readPixels(x, y, 1, 1, gl!.RGBA, gl!.UNSIGNED_BYTE, pixels);
  return [...pixels];
}

const results: Record<string, unknown> = {};

// 1. A bare layer must reproduce its source exactly.
results.bareLayer = renderAndRead(makePlan([{ kind: 'layer', layer: layer('media/red.mp4') }]));

// 2. One effect pass must actually run: swapping R and G turns red into green.
results.onePass = renderAndRead(
  makePlan([
    {
      kind: 'layer',
      layer: layer('media/red.mp4', [pass('swap_rg', { u_mix: { kind: 'float', value: 1 } })]),
    },
  ]),
);

// 3. Two passes must chain through the ping-pong: red halved twice is a quarter.
results.chainedPasses = renderAndRead(
  makePlan([{ kind: 'layer', layer: layer('media/red.mp4', [pass('half_red'), pass('half_red')]) }]),
);

// 4. The mask sampler must be bound to its own unit, not to the source. Red x 0.5 grey is 128; if the
//    mask slot received the source texture instead, the result would be 255.
results.maskBinding = renderAndRead(
  makePlan([{ kind: 'layer', layer: layer('media/red.mp4', [pass('mask_mul', {}, 'm1')]) }]),
);

// 5. Built-in uniforms must be set from the layer, not left at zero.
results.builtins = renderAndRead(
  makePlan([
    {
      kind: 'layer',
      layer: layer('media/red.mp4', [pass('builtin_probe')], { clipTimeSeconds: 0.5, clipLengthSeconds: 1 }),
    },
  ]),
);

// 6. A broken shader must degrade to passthrough and still show the picture.
results.brokenShader = renderAndRead(
  makePlan([{ kind: 'layer', layer: layer('media/red.mp4', [pass('broken')]) }]),
);

// 7. Opacity must blend against what is below: half-opacity blue over red.
results.opacityBlend = renderAndRead(
  makePlan([
    { kind: 'layer', layer: layer('media/red.mp4') },
    { kind: 'layer', layer: layer('media/blue.mp4', [], { transform: { opacity: 0.5 } }) },
  ]),
);

// 8. Layer order: the later item must win when fully opaque.
results.layerOrder = renderAndRead(
  makePlan([
    { kind: 'layer', layer: layer('media/red.mp4') },
    { kind: 'layer', layer: layer('media/blue.mp4') },
  ]),
);

// 9. A transition at progress 0 shows `from`, at 1 shows `to`.
const transitionPlan = (progress: number) =>
  makePlan([
    {
      kind: 'transition',
      group: {
        from: layer('media/red.mp4'),
        to: layer('media/blue.mp4'),
        transition: { instance: effectInstanceId('tr'), effect: effectId('wipe'), progress, uniforms: {} },
      },
    },
  ]);
results.transitionStart = renderAndRead(transitionPlan(0));
results.transitionEnd = renderAndRead(transitionPlan(1));

// 10. A missing texture must skip the layer, not crash or blank everything below.
results.missingTexture = renderAndRead(
  makePlan([
    { kind: 'layer', layer: layer('media/red.mp4') },
    { kind: 'layer', layer: layer('media/missing.mp4') },
  ]),
);

// 11. Render targets must all be returned to the pool: a leak here grows GPU memory per frame.
results.poolLeak = { borrowedAfterRender: pool.borrowedCount() };

// 12. Repeated renders must be stable and must not accumulate borrowed targets.
for (let i = 0; i < 30; i += 1) {
  compositor.render(makePlan([{ kind: 'layer', layer: layer('media/red.mp4', [pass('half_red')]) }]), null);
}
results.poolAfterManyFrames = { borrowed: pool.borrowedCount() };
results.stableRepeat = renderAndRead(
  makePlan([{ kind: 'layer', layer: layer('media/red.mp4', [pass('half_red'), pass('half_red')]) }]),
);

results.programFailures = programs.failures().map((error) => ({
  kind: error.kind,
  effect: 'effect' in error ? error.effect : undefined,
  firstDiagnosticLine: error.kind === 'compile-failed' ? error.diagnostics[0]?.line : undefined,
}));

results.builtinLibrary = builtinResults;

/**
 * The whole mask path, end to end: run-length counts → RGBA → texture → sampler.
 *
 * Every step here has been a real bug in some codebase: a column-major/row-major swap that transposes
 * the mask, a decode emitting 1 instead of 255 so the mask is invisible, a texture bound to the wrong
 * unit. A left-half mask over a red source makes all three fail loudly — the left pixel must be red and
 * the right must be black, and a transposed mask splits top/bottom instead.
 */
{
  const size = 64;
  const bitmap = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) bitmap[y * size + x] = x < size / 2 ? 1 : 0;
  }
  const counts = encodeRle(bitmap, size, size);

  const store = createMaskTextureStore(gl);
  const uploaded = store.set(maskId('m_left'), {
    width: size,
    height: size,
    rgba: toRgba(counts, size, size),
  });

  // Swap in a provider that serves the decoded mask rather than the flat grey stand-in.
  const decoded: TextureProvider = {
    textureFor: textures.textureFor.bind(textures),
    maskTexture: () => store.get(maskId('m_left')),
  };
  const maskCompositor = createGlCompositor({ gl, programs, builtins, pool, textures: decoded });
  maskCompositor.render(
    makePlan([{ kind: 'layer', layer: layer('media/red.mp4', [pass('mask_mul', {}, 'm_left')]) }]),
    null,
  );

  results.decodedMask = {
    uploaded: uploaded !== undefined,
    // Read well inside each half so linear filtering at the boundary cannot blur the assertion.
    inside: readAt(16, 32),
    outside: readAt(48, 32),
    // Both read inside the masked-out half, away from the boundary so linear filtering cannot blur
    // the answer. A transposed mask splits the frame horizontally, which makes these two differ.
    top: readAt(48, 56),
    bottom: readAt(48, 8),
    area: counts.filter((_run, index) => index % 2 === 1).reduce((sum, run) => sum + run, 0),
    glError: gl.getError(),
  };
  maskCompositor.dispose();
  store.dispose();
}

(window as unknown as { __glcheck: unknown }).__glcheck = results;
