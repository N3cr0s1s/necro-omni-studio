import type { RawManifest } from '../registry/effect-registry.js';

/**
 * The built-in effect library.
 *
 * Inlined as strings rather than shipped as files, deliberately. The spec requires that no *specific*
 * effect appears in the application's code, and these do not: they go through exactly the same manifest
 * path as a project-local effect and the registry cannot tell them apart. Inlining only decides where the
 * bytes live, and it means a fresh install has a working effect menu with nothing to install.
 *
 * A project-local effect with the same id overrides its built-in, so none of these is a dead end.
 *
 * Every shader here is compiled by the compositor's GL check, so a syntax error cannot ship.
 */

/** Film grain, the spec's own manifest example (`interfaces.md` §4.1). */
const FILM_GRAIN: RawManifest = {
  origin: 'builtin:film_grain',
  json: {
    id: 'film_grain',
    name: 'Film Grain',
    category: 'effect',
    group: 'Texture',
    shader: 'film_grain.frag',
    samplers: ['source'],
    params: [
      { key: 'amount', uniform: 'u_amount', type: 'float', label: 'Amount', min: 0, max: 1, default: 0.15 },
      { key: 'size', uniform: 'u_size', type: 'float', label: 'Size', min: 0.5, max: 4, default: 1 },
    ],
  },
  shaderSource: `// Value noise from a hash, animated by u_time so the grain moves rather than sitting still as a
// fixed pattern — static grain reads as sensor dirt, not film.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec4 colour = texture(source, v_uv);
  vec2 grainUv = v_uv * u_resolution / max(u_size, 0.001);
  float noise = hash(floor(grainUv) + floor(u_time * 24.0));
  // Centred on zero so grain does not lift the black level.
  fragColor = vec4(colour.rgb + (noise - 0.5) * u_amount, colour.a);
}`,
};

/** Chromatic aberration, as referenced by the mockups' effect stack. */
const RGB_SPLIT: RawManifest = {
  origin: 'builtin:rgb_split',
  json: {
    id: 'rgb_split',
    name: 'RGB Split',
    category: 'effect',
    group: 'Distort',
    shader: 'rgb_split.frag',
    samplers: ['source'],
    params: [
      { key: 'amount', uniform: 'u_amount', type: 'float', label: 'Amount', min: 0, max: 40, default: 4 },
      { key: 'angle', uniform: 'u_angle', type: 'float', label: 'Angle', min: 0, max: 360, default: 0 },
    ],
  },
  shaderSource: `void main() {
  float radians = u_angle * 0.017453292;
  // Offset in pixels, converted to uv, so the effect looks the same at any output resolution.
  vec2 offset = vec2(cos(radians), sin(radians)) * u_amount / u_resolution;
  float r = texture(source, v_uv + offset).r;
  vec4 centre = texture(source, v_uv);
  float b = texture(source, v_uv - offset).b;
  fragColor = vec4(r, centre.g, b, centre.a);
}`,
};

/** Levels, the third entry in the mockups' stack. */
const LEVELS: RawManifest = {
  origin: 'builtin:levels',
  json: {
    id: 'levels',
    name: 'Levels',
    category: 'effect',
    group: 'Colour',
    shader: 'levels.frag',
    samplers: ['source'],
    params: [
      { key: 'black', uniform: 'u_black', type: 'float', label: 'Black', min: 0, max: 1, default: 0 },
      { key: 'white', uniform: 'u_white', type: 'float', label: 'White', min: 0, max: 1, default: 1 },
      { key: 'gamma', uniform: 'u_gamma', type: 'float', label: 'Gamma', min: 0.1, max: 4, default: 1 },
    ],
  },
  shaderSource: `void main() {
  vec4 colour = texture(source, v_uv);
  // Guarded denominator: a user dragging white below black would otherwise divide by zero and produce
  // NaN, which propagates through the rest of the chain as black or garbage.
  float range = max(u_white - u_black, 0.001);
  vec3 levelled = clamp((colour.rgb - u_black) / range, 0.0, 1.0);
  fragColor = vec4(pow(levelled, vec3(1.0 / max(u_gamma, 0.001))), colour.a);
}`,
};

/**
 * Masked blur, the spec's example of a mask sampler (`interfaces.md` §4.3).
 *
 * Its only connection to SAM 2 is declaring the `mask` slot — there is no segmentation-specific code
 * here or anywhere in the effect system.
 */
const BACKGROUND_BLUR: RawManifest = {
  origin: 'builtin:background_blur',
  json: {
    id: 'background_blur',
    name: 'Background Blur',
    category: 'effect',
    group: 'Blur',
    shader: 'background_blur.frag',
    samplers: ['source', 'mask'],
    params: [
      { key: 'radius', uniform: 'u_radius', type: 'float', label: 'Radius', min: 0, max: 40, default: 12 },
      { key: 'invert', uniform: 'u_invert', type: 'bool', label: 'Invert mask', default: false },
    ],
  },
  shaderSource: `void main() {
  float coverage = texture(mask, v_uv).r;
  if (u_invert) coverage = 1.0 - coverage;

  // A separable box blur approximated in one pass: cheap, and at these radii visually adequate for a
  // background. A true gaussian would need two passes and the manifest model gives each effect one.
  vec4 sum = vec4(0.0);
  float weight = 0.0;
  for (int x = -4; x <= 4; x++) {
    for (int y = -4; y <= 4; y++) {
      vec2 offset = vec2(float(x), float(y)) * u_radius / (4.0 * u_resolution);
      sum += texture(source, v_uv + offset);
      weight += 1.0;
    }
  }
  vec4 blurred = sum / weight;
  vec4 sharp = texture(source, v_uv);
  // Mask white keeps the subject sharp; black blurs. Inverting is a parameter, not two effects.
  fragColor = mix(blurred, sharp, coverage);
}`,
};

/** A plain crossfade. The one transition every project needs. */
const CROSSFADE: RawManifest = {
  origin: 'builtin:crossfade',
  json: {
    id: 'crossfade',
    name: 'Crossfade',
    category: 'transition',
    group: 'Dissolve',
    shader: 'crossfade.frag',
    samplers: ['from', 'to'],
    convention: 'gl-transitions',
    params: [],
  },
  shaderSource: `vec4 transition(vec2 uv) {
  return mix(getFromColor(uv), getToColor(uv), progress);
}`,
};

/** A directional wipe, exercising the `ratio` global the gl-transitions wrapper provides. */
const WIPE: RawManifest = {
  origin: 'builtin:wipe',
  json: {
    id: 'wipe',
    name: 'Wipe',
    category: 'transition',
    group: 'Wipe',
    shader: 'wipe.frag',
    samplers: ['from', 'to'],
    convention: 'gl-transitions',
    params: [
      { key: 'softness', uniform: 'softness', type: 'float', label: 'Softness', min: 0, max: 0.5, default: 0.05 },
    ],
  },
  shaderSource: `uniform float softness;

vec4 transition(vec2 uv) {
  // Progress is expanded so the soft edge fully clears both ends; without it the wipe would still show a
  // sliver of the outgoing clip at progress 1.
  float edge = progress * (1.0 + softness * 2.0) - softness;
  float mixAmount = smoothstep(edge - softness, edge + softness, uv.x * ratio / max(ratio, 0.001));
  return mix(getToColor(uv), getFromColor(uv), mixAmount);
}`,
};

/** Every built-in, in menu order. */
export const BUILTIN_EFFECTS: readonly RawManifest[] = [
  FILM_GRAIN,
  RGB_SPLIT,
  LEVELS,
  BACKGROUND_BLUR,
  CROSSFADE,
  WIPE,
];

/** Ids of the built-ins, for tests and for the "reset to defaults" path. */
export const BUILTIN_EFFECT_IDS: readonly string[] = BUILTIN_EFFECTS.map(
  (manifest) => (manifest.json as { id: string }).id,
);
