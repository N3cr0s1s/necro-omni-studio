import { describe, expect, it, vi } from 'vitest';
import { effectId } from '@nos/core';
import type { EffectShaderSource } from '../contracts/effect-source.js';
import { type ShaderCompiler, checkShader, describeCompileCheck } from './compile-check.js';

/**
 * The editor's answer to "does this compile, and where is it wrong?".
 *
 * Driven against a fake driver here, because what needs proving is the *plumbing* — that the source
 * handed to the driver is the assembled one, that reported lines are offset back to the author's file,
 * and that the shader is always deleted. Whether a given GLSL string compiles is the driver's opinion
 * and `glcheck` asks a real one.
 */

const effect: EffectShaderSource = {
  id: effectId('my_effect'),
  category: 'effect',
  samplers: ['source'],
  source: 'void main(){ fragColor = texture(source, v_uv); }',
  uniforms: [],
};

/** A driver that says what it is told to say, and records what it was given. */
function fakeGl(
  overrides: Partial<ShaderCompiler> & { readonly compiles?: boolean; readonly log?: string } = {},
) {
  const handle = {} as WebGLShader;
  const calls = { sources: [] as string[], deleted: 0 };

  const gl: ShaderCompiler = {
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    createShader: () => handle,
    shaderSource: (_shader, source) => void calls.sources.push(source),
    compileShader: () => undefined,
    getShaderParameter: () => overrides.compiles !== false,
    getShaderInfoLog: () => overrides.log ?? '',
    deleteShader: () => void (calls.deleted += 1),
    ...overrides,
  };
  return { gl, calls };
}

describe('a shader that compiles', () => {
  it('is reported as fine', () => {
    const { gl } = fakeGl({ compiles: true });
    expect(checkShader(gl, effect)).toEqual({ ok: true });
  });

  it('is handed the assembled source, not the author’s fragment alone', () => {
    // The same assembly the real pass gets. A second, editor-only path would drift, and the day it did
    // the editor would call a shader good that the compositor then refused.
    const { gl, calls } = fakeGl({ compiles: true });
    checkShader(gl, effect);

    const source = calls.sources[0] ?? '';
    expect(source).toContain('#version 300 es');
    expect(source).toContain('uniform sampler2D source;');
    expect(source).toContain('out vec4 fragColor;');
    expect(source).toContain('void main()');
  });

  it('deletes the shader even when it worked', () => {
    // An editor recompiles on every keystroke; one leaked shader per keystroke is a driver leak that
    // reads as the editor getting slower the longer it is open.
    const { gl, calls } = fakeGl({ compiles: true });
    checkShader(gl, effect);
    expect(calls.deleted).toBe(1);
  });
});

describe('a shader that does not', () => {
  it('reports the line the author wrote, not the line in the assembled source', () => {
    // The whole value of the check: a diagnostic pointing twelve lines past the end of the file is
    // worse than no diagnostic.
    const { gl } = fakeGl({
      compiles: false,
      log: "ERROR: 0:30: 'nosuchfn' : no matching overloaded function found",
    });
    const check = checkShader(gl, effect);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.diagnostics[0]?.line).toBeLessThan(30);
    expect(check.diagnostics[0]?.line).toBeGreaterThan(0);
  });

  it('does not claim a line for a diagnostic that is not in the author’s file', () => {
    /*
     * `parseShaderLog` maps anything it cannot place — and anything the driver reported inside the
     * generated preamble — to line 0. "line 0" sends someone looking at a line that does not exist.
     */
    const { gl } = fakeGl({ compiles: false, log: "ERROR: 0:2: 'x' : syntax error" });
    expect(describeCompileCheck(checkShader(gl, effect))).not.toContain('line 0');
  });

  it('keeps what the driver said, even when nothing parses out of it', () => {
    const { gl } = fakeGl({ compiles: false, log: 'something the parser does not know' });
    const check = checkShader(gl, effect);
    if (check.ok) return;
    expect(check.log).toBe('something the parser does not know');
  });

  it('deletes the shader', () => {
    const { gl, calls } = fakeGl({ compiles: false, log: 'ERROR: 0:3: bad' });
    checkShader(gl, effect);
    expect(calls.deleted).toBe(1);
  });
});

describe('a context that cannot make a shader', () => {
  it('says so rather than blaming the GLSL', () => {
    // A missing context is not a broken shader, and telling the author their code is wrong is a lie.
    const { gl } = fakeGl({ createShader: () => null });
    const check = checkShader(gl, effect);

    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.kind).toBe('unavailable');
    expect(describeCompileCheck(check)).toContain('no graphics context');
  });

  it('does not try to delete a shader it never made', () => {
    const deleteShader = vi.fn();
    const { gl } = fakeGl({ createShader: () => null, deleteShader });
    checkShader(gl, effect);
    expect(deleteShader).not.toHaveBeenCalled();
  });
});

describe('the line the editor shows', () => {
  it('is nothing at all when the shader is fine', () => {
    expect(describeCompileCheck({ ok: true })).toBeUndefined();
  });

  it('names the line and the message', () => {
    // Beyond the generated preamble, so it maps to a line the author actually has.
    const { gl } = fakeGl({ compiles: false, log: "ERROR: 0:30: 'x' : undeclared identifier" });
    const check = checkShader(gl, effect);
    expect(describeCompileCheck(check)).toMatch(/^line \d+: /);
    expect(describeCompileCheck(check)).toContain('undeclared identifier');
  });

  it('shows the first diagnostic only, because compilers cascade', () => {
    // The second error is usually the first one's consequence, and a wall of them buries the one line
    // that matters.
    const { gl } = fakeGl({
      compiles: false,
      log: "ERROR: 0:30: 'x' : undeclared identifier\nERROR: 0:31: 'y' : undeclared identifier",
    });
    const shown = describeCompileCheck(checkShader(gl, effect)) ?? '';
    expect(shown).toContain("'x'");
    expect(shown).not.toContain("'y'");
  });

  it('shows an unplaceable message on its own, without a made-up line', () => {
    // `parseShaderLog` keeps an unrecognised line as a line-0 diagnostic rather than discarding it —
    // an error the user can still read beats a swallowed one — so this arrives parsed, at line 0.
    const { gl } = fakeGl({ compiles: false, log: 'out of memory' });
    expect(describeCompileCheck(checkShader(gl, effect))).toBe('out of memory');
  });

  it('says something even when the driver said nothing', () => {
    const { gl } = fakeGl({ compiles: false, log: '' });
    expect(describeCompileCheck(checkShader(gl, effect))).toBe('the shader did not compile');
  });
});
