import type { EffectShaderSource, ShaderDiagnostic } from '../contracts/effect-source.js';

/**
 * GLSL assembly.
 *
 * Effect authors write a fragment shader body against a small documented surface; this module wraps
 * it into a complete GLSL ES 3.0 program. Two things make the wrapper worth having rather than asking
 * authors to write boilerplate:
 *
 * - The spec fixes a set of always-available uniforms (`u_resolution`, `u_time`, `u_clip_time`,
 *   `u_clip_length`) that must not need declaring. Generating them means an effect cannot forget one
 *   or spell it differently.
 * - The spec requires gl-transitions shaders to work by copy-paste. That library's shaders assume
 *   `getFromColor(uv)`, `getToColor(uv)` and a `transition(vec2 uv)` entry point, none of which is
 *   GLSL — the wrapper supplies them.
 *
 * The preamble line count is tracked so compiler diagnostics can be reported against the line the
 * author actually wrote. Without that, every error points at a line number the author cannot find.
 */

/**
 * Fullscreen quad vertex shader.
 *
 * Positions are generated from `gl_VertexID` rather than read from a buffer, so drawing a pass needs
 * no vertex attributes and no VAO switching — just `drawArrays(TRIANGLES, 0, 3)`. The oversized
 * triangle covers the viewport with three vertices instead of six.
 */
export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  // A single triangle covering the clip space square, so no vertex buffer is needed.
  vec2 position = vec2(
    (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 2) ? 3.0 : -1.0
  );
  v_uv = (position + 1.0) * 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

/** Uniforms every effect can use without declaring them, per the spec. */
export const BUILTIN_UNIFORMS = [
  'u_resolution',
  'u_time',
  'u_clip_time',
  'u_clip_length',
] as const;

export type BuiltinUniform = (typeof BUILTIN_UNIFORMS)[number];

const BUILTIN_PREAMBLE = `uniform vec2  u_resolution;   // output resolution in pixels
uniform float u_time;         // timeline time in seconds
uniform float u_clip_time;    // clip-relative time in seconds
uniform float u_clip_length;  // clip duration in seconds`;

export interface AssembledShader {
  readonly source: string;
  /**
   * Lines the wrapper added before the author's first line.
   *
   * Subtracted from driver diagnostics so a reported line matches the authored file.
   */
  readonly preambleLines: number;
  /** Sampler uniform names in binding order, so texture units can be assigned deterministically. */
  readonly samplers: readonly string[];
}

/**
 * Assembles a complete fragment shader.
 *
 * Sampler declarations are generated from the manifest rather than the shader body, which is what
 * lets the mask slot be a pure manifest concern: an effect declaring `["source", "mask"]` gets a
 * `mask` sampler with no shader change, and the compositor binds a cached mask texture to it. That is
 * the only coupling between segmentation and the effect system.
 */
export function assembleFragmentShader(effect: EffectShaderSource): AssembledShader {
  const samplers = effect.convention === 'gl-transitions' ? ['from', 'to'] : effect.samplers;
  const lines: string[] = [];

  lines.push('#version 300 es');
  lines.push('precision highp float;');
  lines.push('precision highp sampler2D;');
  lines.push('');
  lines.push('in vec2 v_uv;');
  lines.push('out vec4 fragColor;');
  lines.push('');
  lines.push(BUILTIN_PREAMBLE);
  lines.push('');

  for (const sampler of samplers) {
    lines.push(`uniform sampler2D ${sampler};`);
  }

  // Parameter declarations, so an author writes `u_amount` in the body without a `uniform` line.
  // Skipped when the source brings its own — a duplicate declaration is a compile error.
  const declaresOwn = effect.declaresOwnUniforms ?? effect.convention === 'gl-transitions';
  if (!declaresOwn && effect.uniforms.length > 0) {
    lines.push('');
    for (const uniform of effect.uniforms) {
      lines.push(`uniform ${uniform.type} ${uniform.name};`);
    }
  }

  if (effect.convention === 'gl-transitions') {
    lines.push('');
    lines.push(...glTransitionsPreamble(effect.progressUniform ?? 'progress'));
  }

  lines.push('');
  lines.push('// ---- authored shader below ----');

  const header = lines.join('\n');
  // Counted from the joined text, not from `lines.length`: some entries are themselves multi-line
  // (the built-in uniform block is four lines in one string), so the array length undercounts and
  // every diagnostic would be reported several lines off the line the author actually wrote.
  const preambleLines = header.split('\n').length;

  const body =
    effect.convention === 'gl-transitions'
      ? `${effect.source}\n\n${GL_TRANSITIONS_MAIN}`
      : effect.source;

  return {
    source: `${header}\n${body}\n`,
    preambleLines,
    samplers,
  };
}

/**
 * The gl-transitions compatibility layer.
 *
 * `getFromColor`/`getToColor` are the library's sampling accessors. `ratio` is declared because many
 * of its shaders reference it for aspect-correct effects; deriving it from `u_resolution` means an
 * effect manifest never has to supply it.
 */
function glTransitionsPreamble(progressUniform: string): readonly string[] {
  return [
    `uniform float ${progressUniform};`,
    '',
    '// gl-transitions compatibility surface.',
    // Declared without an initializer and assigned in main: GLSL ES requires a global initializer to
    // be a constant expression, so `float ratio = u_resolution.x / u_resolution.y;` at file scope is a
    // compile error. The library's shaders read `ratio` from inside transition(), which runs after the
    // assignment, so this is equivalent for them.
    'float ratio;',
    '',
    'vec4 getFromColor(vec2 uv) { return texture(from, uv); }',
    'vec4 getToColor(vec2 uv) { return texture(to, uv); }',
  ];
}

/** Entry point appended after a gl-transitions shader, which defines `transition` but no `main`. */
const GL_TRANSITIONS_MAIN = `void main() {
  ratio = u_resolution.x / max(u_resolution.y, 1.0);
  fragColor = transition(v_uv);
}`;

/**
 * Passthrough shader.
 *
 * Used when an effect fails to compile. The spec requires a broken effect to fall back to
 * passthrough so neither the preview nor an export stops — a render that halts on a typo would make
 * shader authoring impractical.
 */
export const PASSTHROUGH_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D source;

void main() {
  fragColor = texture(source, v_uv);
}
`;

/**
 * Composite shader: draws a layer onto the accumulator with a transform and opacity.
 *
 * The inverse transform is applied to the *sampling* coordinate rather than to geometry, so a layer
 * can be positioned, scaled and rotated without touching vertex data. `u_layer_opacity` multiplies
 * alpha for the standard source-over blend the compositor sets up.
 */
export const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D source;
uniform vec2  u_offset;
uniform float u_scale;
uniform float u_rotation;
uniform float u_layer_opacity;
uniform vec2  u_resolution;

void main() {
  // Work in a centred, aspect-corrected space so rotation is not skewed by a non-square output.
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 centred = (v_uv - 0.5 - u_offset) * vec2(aspect, 1.0);

  float c = cos(-u_rotation);
  float s = sin(-u_rotation);
  vec2 rotated = vec2(centred.x * c - centred.y * s, centred.x * s + centred.y * c);

  vec2 uv = rotated / max(u_scale, 1e-6) / vec2(aspect, 1.0) + 0.5;

  // Outside the layer's own bounds there is nothing to draw. Discarding rather than clamping avoids
  // smearing the edge pixel across the frame, which is what CLAMP_TO_EDGE would do.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }

  vec4 colour = texture(source, uv);
  fragColor = vec4(colour.rgb, colour.a * u_layer_opacity);
}
`;

/**
 * Parses a driver info log into structured diagnostics.
 *
 * Every vendor formats these differently; the two dominant shapes are
 * `ERROR: 0:12: 'x' : undeclared identifier` (ANGLE, Mesa) and `0(12) : error C1234: ...` (NVIDIA).
 * Both are handled, and anything unrecognized is kept as a line-0 message rather than discarded —
 * an unparsed error the user can still read beats a swallowed one.
 */
export function parseShaderLog(log: string, preambleLines: number): readonly ShaderDiagnostic[] {
  const diagnostics: ShaderDiagnostic[] = [];

  for (const rawLine of log.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const angle = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/i.exec(line);
    if (angle !== null) {
      diagnostics.push({
        severity: angle[1]!.toUpperCase() === 'WARNING' ? 'warning' : 'error',
        line: toAuthoredLine(Number(angle[2]), preambleLines),
        message: angle[3]!.trim(),
      });
      continue;
    }

    const nvidia = /^\d+\((\d+)\)\s*:\s*(error|warning)\s*\w*:\s*(.*)$/i.exec(line);
    if (nvidia !== null) {
      diagnostics.push({
        severity: nvidia[2]!.toLowerCase() === 'warning' ? 'warning' : 'error',
        line: toAuthoredLine(Number(nvidia[1]), preambleLines),
        message: nvidia[3]!.trim(),
      });
      continue;
    }

    diagnostics.push({ severity: 'error', line: 0, message: line });
  }

  return diagnostics;
}

/**
 * Rebases a compiler line number onto the authored source.
 *
 * A diagnostic inside the generated preamble cannot be attributed to the author, so it reports as
 * line 0 rather than a negative number that would look like a parser bug.
 */
function toAuthoredLine(compilerLine: number, preambleLines: number): number {
  const authored = compilerLine - preambleLines;
  return authored > 0 ? authored : 0;
}
