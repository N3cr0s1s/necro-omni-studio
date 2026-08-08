import { describe, expect, it } from 'vitest';
import { effectId } from '@nos/core';
import type { EffectShaderSource } from '../contracts/effect-source.js';
import {
  BUILTIN_UNIFORMS,
  COMPOSITE_FRAGMENT_SHADER,
  FULLSCREEN_VERTEX_SHADER,
  PASSTHROUGH_FRAGMENT_SHADER,
  assembleFragmentShader,
  parseShaderLog,
} from './shader-source.js';

/** The film grain effect from the spec's manifest example. */
const filmGrain: EffectShaderSource = {
  id: effectId('film_grain'),
  category: 'effect',
  source: `void main() {
  vec4 colour = texture(source, v_uv);
  float noise = fract(sin(dot(v_uv * u_size, vec2(12.9898, 78.233))) * 43758.5453);
  fragColor = vec4(colour.rgb + (noise - 0.5) * u_amount, colour.a);
}`,
  samplers: ['source'],
  uniforms: [
    { name: 'u_amount', type: 'float' },
    { name: 'u_size', type: 'float' },
  ],
};

/**
 * An unmodified gl-transitions shader.
 *
 * Copied in the shape that library publishes: a `transition(vec2 uv)` function referencing
 * `getFromColor`, `getToColor`, `progress` and `ratio`, with no `main` and no uniform declarations for
 * the samplers. The spec requires these to work by copy-paste.
 */
const crosswarp: EffectShaderSource = {
  id: effectId('crosswarp'),
  category: 'transition',
  source: `vec4 transition(vec2 p) {
  float x = progress;
  x = smoothstep(0.0, 1.0, (x * 2.0 + p.x - 1.0));
  return mix(getFromColor((p - 0.5) * (1.0 - x) + 0.5), getToColor((p - 0.5) * x + 0.5), x);
}`,
  samplers: ['from', 'to'],
  convention: 'gl-transitions',
  uniforms: [{ name: 'strength', type: 'float' }],
};

describe('vertex shader', () => {
  it('needs no vertex attributes, so a pass is one drawArrays call', () => {
    expect(FULLSCREEN_VERTEX_SHADER).toContain('gl_VertexID');
    expect(FULLSCREEN_VERTEX_SHADER).not.toContain('in vec');
  });

  it('declares the ES 3.0 version first, as GLSL requires', () => {
    expect(FULLSCREEN_VERTEX_SHADER.startsWith('#version 300 es')).toBe(true);
  });

  it('passes uv to the fragment stage', () => {
    expect(FULLSCREEN_VERTEX_SHADER).toContain('out vec2 v_uv');
  });
});

describe('assembleFragmentShader', () => {
  it('puts the version directive on the first line', () => {
    // Anything before #version is a compile error, including a comment.
    const assembled = assembleFragmentShader(filmGrain);
    expect(assembled.source.split('\n')[0]).toBe('#version 300 es');
  });

  it('declares every built-in uniform the spec guarantees', () => {
    const assembled = assembleFragmentShader(filmGrain);
    for (const uniform of BUILTIN_UNIFORMS) {
      expect(assembled.source).toContain(uniform);
    }
  });

  it('generates sampler declarations from the manifest, not the shader body', () => {
    // This is what lets a mask slot be purely a manifest concern.
    const assembled = assembleFragmentShader({
      ...filmGrain,
      samplers: ['source', 'mask'],
    });
    expect(assembled.source).toContain('uniform sampler2D source;');
    expect(assembled.source).toContain('uniform sampler2D mask;');
    expect(assembled.samplers).toEqual(['source', 'mask']);
  });

  it('preserves the authored body verbatim', () => {
    const assembled = assembleFragmentShader(filmGrain);
    expect(assembled.source).toContain(filmGrain.source);
  });

  it('declares the fragment output', () => {
    expect(assembleFragmentShader(filmGrain).source).toContain('out vec4 fragColor');
  });

  it('reports how many lines it prepended, so diagnostics can be rebased', () => {
    const assembled = assembleFragmentShader(filmGrain);
    const lines = assembled.source.split('\n');
    // The authored source must begin exactly after the reported preamble.
    expect(lines[assembled.preambleLines]).toBe(filmGrain.source.split('\n')[0]);
  });
});

describe('gl-transitions convention', () => {
  it('supplies the sampling accessors the library assumes', () => {
    const assembled = assembleFragmentShader(crosswarp);
    expect(assembled.source).toContain('vec4 getFromColor(vec2 uv)');
    expect(assembled.source).toContain('vec4 getToColor(vec2 uv)');
  });

  it('declares the progress uniform', () => {
    expect(assembleFragmentShader(crosswarp).source).toContain('uniform float progress;');
  });

  it('honours a custom progress uniform name', () => {
    const assembled = assembleFragmentShader({ ...crosswarp, progressUniform: 'u_progress' });
    expect(assembled.source).toContain('uniform float u_progress;');
    expect(assembled.source).not.toContain('uniform float progress;');
  });

  it('provides ratio without a global initializer, which GLSL ES forbids', () => {
    // A real compiler rejects `float ratio = u_resolution.x / u_resolution.y;` at file scope:
    // global initializers must be constant expressions. It is declared here and assigned in main,
    // which runs before transition() reads it.
    const assembled = assembleFragmentShader(crosswarp);
    expect(assembled.source).toContain('float ratio;');
    expect(assembled.source).not.toContain('float ratio =');
    expect(assembled.source).toContain('ratio = u_resolution.x / max(u_resolution.y, 1.0);');
  });

  it('declares parameter uniforms for an effect that does not bring its own', () => {
    // Without this an author writing `u_amount` in the body gets "undeclared identifier" from the
    // driver — the wrapper is what makes the manifest the single declaration site.
    const assembled = assembleFragmentShader(filmGrain);
    expect(assembled.source).toContain('uniform float u_amount;');
    expect(assembled.source).toContain('uniform float u_size;');
  });

  it('does not re-declare uniforms a gl-transitions shader already declares', () => {
    // A duplicate declaration is a compile error, and that library's shaders carry their own.
    const assembled = assembleFragmentShader(crosswarp);
    expect(assembled.source.match(/uniform float strength;/g)).toBeNull();
  });

  it('honours an explicit declaresOwnUniforms flag', () => {
    const assembled = assembleFragmentShader({ ...filmGrain, declaresOwnUniforms: true });
    expect(assembled.source).not.toContain('uniform float u_amount;');
  });

  it('declares each uniform with its manifest type', () => {
    const assembled = assembleFragmentShader({
      ...filmGrain,
      uniforms: [
        { name: 'u_tint', type: 'vec4' },
        { name: 'u_invert', type: 'bool' },
        { name: 'u_steps', type: 'int' },
      ],
    });
    expect(assembled.source).toContain('uniform vec4 u_tint;');
    expect(assembled.source).toContain('uniform bool u_invert;');
    expect(assembled.source).toContain('uniform int u_steps;');
  });

  it('appends a main that calls transition, which the library shader does not define', () => {
    const assembled = assembleFragmentShader(crosswarp);
    expect(assembled.source).toContain('fragColor = transition(v_uv);');
    expect(crosswarp.source).not.toContain('void main');
  });

  it('binds from and to samplers regardless of what the manifest lists', () => {
    // The convention fixes the sampler names, so a manifest typo cannot break a library shader.
    const assembled = assembleFragmentShader({ ...crosswarp, samplers: ['whatever'] });
    expect(assembled.samplers).toEqual(['from', 'to']);
    expect(assembled.source).toContain('uniform sampler2D from;');
  });

  it('produces exactly one main for a transition', () => {
    const assembled = assembleFragmentShader(crosswarp);
    expect(assembled.source.match(/void main\(\)/g)).toHaveLength(1);
  });
});

describe('built-in programs', () => {
  it('passthrough samples the source unchanged', () => {
    // The spec's fallback for a broken shader: render must not stop.
    expect(PASSTHROUGH_FRAGMENT_SHADER).toContain('texture(source, v_uv)');
    expect(PASSTHROUGH_FRAGMENT_SHADER.startsWith('#version 300 es')).toBe(true);
  });

  it('the composite shader applies the inverse transform to the sample coordinate', () => {
    // Transforming the lookup rather than geometry means no vertex data changes per layer.
    expect(COMPOSITE_FRAGMENT_SHADER).toContain('u_offset');
    expect(COMPOSITE_FRAGMENT_SHADER).toContain('u_scale');
    expect(COMPOSITE_FRAGMENT_SHADER).toContain('u_rotation');
    expect(COMPOSITE_FRAGMENT_SHADER).toContain('u_layer_opacity');
  });

  it('the composite shader corrects for aspect so rotation is not skewed', () => {
    expect(COMPOSITE_FRAGMENT_SHADER).toContain('aspect');
  });

  it('the composite shader guards against a zero scale', () => {
    // A keyframed scale passing through zero would otherwise divide by zero.
    expect(COMPOSITE_FRAGMENT_SHADER).toContain('max(u_scale, 1e-6)');
  });

  it('the composite shader emits nothing outside the layer bounds', () => {
    // Clamping would smear the edge pixel across the whole frame.
    expect(COMPOSITE_FRAGMENT_SHADER).toContain('fragColor = vec4(0.0);');
  });
});

describe('parseShaderLog', () => {
  it('parses the ANGLE and Mesa format, rebasing onto the authored line', () => {
    const diagnostics = parseShaderLog(
      "ERROR: 0:25: 'u_missing' : undeclared identifier",
      20,
    );
    expect(diagnostics).toEqual([
      { severity: 'error', line: 5, message: "'u_missing' : undeclared identifier" },
    ]);
  });

  it('parses the NVIDIA format', () => {
    const diagnostics = parseShaderLog('0(25) : error C1503: undefined variable "foo"', 20);
    expect(diagnostics[0]).toEqual({
      severity: 'error',
      line: 5,
      message: 'undefined variable "foo"',
    });
  });

  it('distinguishes warnings from errors', () => {
    const diagnostics = parseShaderLog('WARNING: 0:22: unused variable', 20);
    expect(diagnostics[0]!.severity).toBe('warning');
  });

  it('reports a preamble error as line 0 rather than a negative line', () => {
    // A negative line number would look like a parser bug to the user.
    const diagnostics = parseShaderLog("ERROR: 0:3: 'x' : syntax error", 20);
    expect(diagnostics[0]!.line).toBe(0);
  });

  it('keeps an unrecognized message rather than swallowing it', () => {
    // An unparsed error the user can read beats a silent one.
    const diagnostics = parseShaderLog('something the driver invented', 20);
    expect(diagnostics).toEqual([
      { severity: 'error', line: 0, message: 'something the driver invented' },
    ]);
  });

  it('parses a multi-line log', () => {
    const diagnostics = parseShaderLog(
      ["ERROR: 0:25: 'a' : undeclared identifier", "ERROR: 0:27: 'b' : undeclared identifier"].join(
        '\n',
      ),
      20,
    );
    expect(diagnostics.map((entry) => entry.line)).toEqual([5, 7]);
  });

  it('ignores blank lines and a trailing null terminator', () => {
    expect(parseShaderLog('\n\n', 20)).toEqual([]);
  });

  it('handles an empty log', () => {
    expect(parseShaderLog('', 0)).toEqual([]);
  });
});
