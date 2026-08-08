import { describe, expect, it } from 'vitest';
import { effectId } from '@nos/core';
import { paramKeyOf } from '@nos/compositor';
import { BUILTIN_EFFECTS, BUILTIN_EFFECT_IDS } from '../builtin/builtin-effects.js';
import { isNumericParam, manifestLabel, paramLabel } from '../manifest/effect-manifest.js';
import {
  type RawManifest,
  createEffectRegistry,
  defaultParams,
  describeEntryProblem,
} from './effect-registry.js';

const shader = 'void main() { fragColor = texture(source, v_uv); }';

function manifest(json: unknown, shaderSource: string = shader): RawManifest {
  return { origin: 'test.json', json, shaderSource };
}

/**
 * A manifest whose shader file was not found.
 *
 * A separate helper rather than `manifest(json, undefined)`: passing `undefined` explicitly triggers a
 * JavaScript default parameter instead of overriding it, so that call would silently supply a shader.
 */
function manifestWithoutShader(json: unknown): RawManifest {
  return { origin: 'test.json', json, shaderSource: undefined };
}

const validEffect = {
  id: 'film_grain',
  name: 'Film Grain',
  category: 'effect',
  shader: 'film_grain.frag',
  samplers: ['source'],
  params: [{ key: 'amount', uniform: 'u_amount', type: 'float', min: 0, max: 1, default: 0.15 }],
};

describe('valid manifests', () => {
  it('registers an effect as available', () => {
    const registry = createEffectRegistry([manifest(validEffect)]);
    expect(registry.available()).toHaveLength(1);
    expect(registry.resolve(effectId('film_grain'))).toBeDefined();
  });

  it('projects the manifest onto what the compositor needs, and no more', () => {
    const registry = createEffectRegistry([manifest(validEffect)]);
    const source = registry.resolve(effectId('film_grain'))!;
    expect(source.category).toBe('effect');
    expect(source.samplers).toEqual(['source']);
    expect(source.uniforms).toEqual([{ name: 'u_amount', type: 'float', paramKey: 'amount' }]);
    // Labels, ranges and groups must not leak into the render path, or the manifest format could not
    // grow without touching the compositor.
    expect('params' in source).toBe(false);
  });

  it('carries the document key separately from the uniform name', () => {
    const registry = createEffectRegistry([manifest(validEffect)]);
    const uniform = registry.resolve(effectId('film_grain'))!.uniforms[0]!;
    expect(uniform.name).toBe('u_amount');
    expect(paramKeyOf(uniform)).toBe('amount');
  });

  it('defaults the uniform name to the key when a manifest gives only one', () => {
    const registry = createEffectRegistry([
      manifest({ ...validEffect, params: [{ key: 'strength', type: 'float' }] }),
    ]);
    const uniform = registry.resolve(effectId('film_grain'))!.uniforms[0]!;
    expect(uniform.name).toBe('strength');
    expect(paramKeyOf(uniform)).toBe('strength');
  });

  it('maps manifest types onto GLSL types', () => {
    const registry = createEffectRegistry([
      manifest({
        ...validEffect,
        params: [
          { key: 'a', type: 'float' },
          { key: 'b', type: 'int' },
          { key: 'c', type: 'bool' },
          { key: 'd', type: 'color' },
          { key: 'e', type: 'vec2' },
        ],
      }),
    ]);
    expect(registry.resolve(effectId('film_grain'))!.uniforms.map((u) => u.type)).toEqual([
      'float',
      'int',
      'bool',
      // A colour is RGBA, so four components even though the manifest calls it `color`.
      'vec4',
      'vec2',
    ]);
  });

  it('defaults samplers to source for an effect', () => {
    const registry = createEffectRegistry([
      manifest({ id: 'x', category: 'effect', shader: 'x.frag', params: [] }),
    ]);
    expect(registry.resolve(effectId('x'))!.samplers).toEqual(['source']);
  });

  it('accepts a mask sampler, the only link between segmentation and effects', () => {
    const registry = createEffectRegistry([
      manifest({ ...validEffect, id: 'blur', samplers: ['source', 'mask'] }),
    ]);
    expect(registry.resolve(effectId('blur'))!.samplers).toEqual(['source', 'mask']);
  });
});

describe('transitions', () => {
  const validTransition = {
    id: 'crosswarp',
    name: 'Crosswarp',
    category: 'transition',
    shader: 'crosswarp.frag',
    samplers: ['from', 'to'],
    convention: 'gl-transitions',
    progress_uniform: 'progress',
    params: [{ key: 'strength', uniform: 'strength', type: 'float', default: 0.4 }],
  };

  it('accepts the on-disk snake_case progress_uniform', () => {
    // The file format is the user's contract; the in-memory model is camelCase.
    const registry = createEffectRegistry([manifest(validTransition, 'vec4 transition(vec2 u){return vec4(0);}')]);
    expect(registry.resolve(effectId('crosswarp'))!.progressUniform).toBe('progress');
  });

  it('marks a gl-transitions shader as declaring its own uniforms', () => {
    // Re-declaring one would be a duplicate declaration and a compile error.
    const registry = createEffectRegistry([manifest(validTransition, 'vec4 transition(vec2 u){return vec4(0);}')]);
    expect(registry.resolve(effectId('crosswarp'))!.declaresOwnUniforms).toBe(true);
  });

  it('defaults transition samplers to from and to', () => {
    const registry = createEffectRegistry([
      manifest({ id: 't', category: 'transition', shader: 't.frag', params: [] }, 'x'),
    ]);
    expect(registry.resolve(effectId('t'))!.samplers).toEqual(['from', 'to']);
  });

  it('rejects a transition missing a required sampler', () => {
    const registry = createEffectRegistry([
      manifest({ id: 't', category: 'transition', shader: 't.frag', samplers: ['from'], params: [] }, 'x'),
    ]);
    expect(registry.problems()).toHaveLength(1);
  });
});

describe('invalid manifests', () => {
  it('keeps a broken manifest with its reason rather than dropping it', () => {
    // The spec's rule for generators, applied to effects: a silently missing tool costs hours.
    const registry = createEffectRegistry([manifest({ id: 'bad', category: 'effect' })]);
    const problems = registry.problems();
    expect(problems).toHaveLength(1);
    expect(problems[0]!.status).toBe('invalid');
    expect(registry.resolve(effectId('bad'))).toBeUndefined();
  });

  it('reports the id of a broken manifest when it can be read', () => {
    const registry = createEffectRegistry([manifest({ id: 'bad', category: 'effect' })]);
    expect(registry.problems()[0]!.id).toBe('bad');
  });

  it('names the origin so the user can find the file', () => {
    const registry = createEffectRegistry([
      { origin: 'effects/broken.json', json: {}, shaderSource: shader },
    ]);
    expect(describeEntryProblem(registry.problems()[0]!)).toContain('effects/broken.json');
  });

  it('names every problem with its JSON path', () => {
    const registry = createEffectRegistry([
      manifest({ id: 'x', category: 'effect', shader: '', params: [{ type: 'float' }] }),
    ]);
    const problem = registry.problems()[0]!;
    if (problem.status !== 'invalid') throw new Error('expected invalid');
    const paths = problem.issues.map((issue) => issue.path);
    expect(paths).toContain('shader');
    expect(paths.some((path) => path.startsWith('params['))).toBe(true);
  });

  it('rejects an unknown category against that field', () => {
    const registry = createEffectRegistry([manifest({ id: 'x', category: 'filter' })]);
    const problem = registry.problems()[0]!;
    if (problem.status !== 'invalid') throw new Error('expected invalid');
    expect(problem.issues[0]!.path).toBe('category');
    expect(problem.issues[0]!.message).toContain('unknown category');
  });

  it('records a missing shader distinctly from a bad manifest', () => {
    // Different fixes: one is a typo in JSON, the other is a missing file.
    const registry = createEffectRegistry([manifestWithoutShader(validEffect)]);
    const problem = registry.problems()[0]!;
    expect(problem.status).toBe('missing-shader');
    expect(describeEntryProblem(problem)).toContain('film_grain.frag');
  });

  it('loads the good manifests alongside a broken one', () => {
    // One bad file in effects/ must not prevent the other nine from loading.
    const registry = createEffectRegistry([
      manifest(validEffect),
      manifest({ nonsense: true }),
      manifest({ ...validEffect, id: 'levels' }),
    ]);
    expect(registry.available()).toHaveLength(2);
    expect(registry.problems()).toHaveLength(1);
  });

  it('never throws, whatever the input', () => {
    for (const json of [null, 42, 'string', [], { params: 'not an array' }]) {
      expect(() => createEffectRegistry([manifest(json)])).not.toThrow();
    }
  });
});

describe('precedence', () => {
  it('lets a later manifest override an earlier one with the same id', () => {
    // A project-local effect overriding a built-in, matching how the spec ranks project generators above
    // the global library.
    const registry = createEffectRegistry([
      manifest({ ...validEffect, samplers: ['source'] }),
      manifest({ ...validEffect, samplers: ['source', 'mask'] }),
    ]);
    expect(registry.resolve(effectId('film_grain'))!.samplers).toEqual(['source', 'mask']);
  });

  it('still lists both entries, so a shadowed effect is visible', () => {
    const registry = createEffectRegistry([manifest(validEffect), manifest(validEffect)]);
    expect(registry.entries()).toHaveLength(2);
  });
});

describe('keyframability', () => {
  it('defaults numeric parameters to keyframable, per the spec', () => {
    const registry = createEffectRegistry([
      manifest({ ...validEffect, params: [{ key: 'a', type: 'float' }] }),
    ]);
    expect(registry.manifestFor(effectId('film_grain'))!.params[0]!.keyframable).toBe(true);
  });

  it('forces non-numeric parameters to non-keyframable', () => {
    // Interpolating a boolean is meaningless and would put un-renderable keyframes in the document.
    const registry = createEffectRegistry([
      manifest({
        ...validEffect,
        params: [
          { key: 'flag', type: 'bool', keyframable: true },
          { key: 'tint', type: 'color', keyframable: true },
        ],
      }),
    ]);
    const params = registry.manifestFor(effectId('film_grain'))!.params;
    expect(params.every((param) => param.keyframable === false)).toBe(true);
  });

  it('honours an explicit opt-out on a numeric parameter', () => {
    const registry = createEffectRegistry([
      manifest({ ...validEffect, params: [{ key: 'a', type: 'float', keyframable: false }] }),
    ]);
    expect(registry.manifestFor(effectId('film_grain'))!.params[0]!.keyframable).toBe(false);
  });

  it('classifies which types are numeric', () => {
    expect(isNumericParam('float')).toBe(true);
    expect(isNumericParam('int')).toBe(true);
    expect(isNumericParam('vec2')).toBe(true);
    expect(isNumericParam('bool')).toBe(false);
    expect(isNumericParam('color')).toBe(false);
  });
});

describe('defaultParams', () => {
  it('uses the declared defaults', () => {
    const registry = createEffectRegistry([manifest(validEffect)]);
    expect(defaultParams(registry.manifestFor(effectId('film_grain'))!)).toEqual({ amount: 0.15 });
  });

  it('falls back to the midpoint of a declared range', () => {
    // A range means the author has an opinion about the useful span; its middle beats an endpoint.
    const registry = createEffectRegistry([
      manifest({ ...validEffect, params: [{ key: 'a', type: 'float', min: 2, max: 8 }] }),
    ]);
    expect(defaultParams(registry.manifestFor(effectId('film_grain'))!)).toEqual({ a: 5 });
  });

  it('produces a neutral value per type when nothing is declared', () => {
    // An omitted uniform reads as zero in GLSL, which for a scale-like parameter hides the picture.
    const registry = createEffectRegistry([
      manifest({
        ...validEffect,
        params: [
          { key: 'f', type: 'float' },
          { key: 'b', type: 'bool' },
          { key: 'c', type: 'color' },
          { key: 'v', type: 'vec2' },
        ],
      }),
    ]);
    expect(defaultParams(registry.manifestFor(effectId('film_grain'))!)).toEqual({
      f: 0,
      b: false,
      c: [1, 1, 1, 1],
      v: [0, 0],
    });
  });
});

describe('labels', () => {
  it('falls back from a missing label to the key', () => {
    const registry = createEffectRegistry([
      manifest({ ...validEffect, params: [{ key: 'amount', type: 'float' }] }),
    ]);
    expect(paramLabel(registry.manifestFor(effectId('film_grain'))!.params[0]!)).toBe('amount');
  });

  it('falls back from a missing name to the id', () => {
    const registry = createEffectRegistry([
      manifest({ id: 'x', category: 'effect', shader: 'x.frag', params: [] }),
    ]);
    expect(manifestLabel(registry.manifestFor(effectId('x'))!)).toBe('x');
  });
});

describe('built-in library', () => {
  it('registers every built-in as available', () => {
    const registry = createEffectRegistry(BUILTIN_EFFECTS);
    expect(registry.problems()).toEqual([]);
    expect(registry.available()).toHaveLength(BUILTIN_EFFECTS.length);
  });

  it('covers the effects the mockups show in the stack', () => {
    for (const id of ['film_grain', 'rgb_split', 'levels']) {
      expect(BUILTIN_EFFECT_IDS).toContain(id);
    }
  });

  it('includes the masked effect the spec uses as its example', () => {
    const registry = createEffectRegistry(BUILTIN_EFFECTS);
    expect(registry.resolve(effectId('background_blur'))!.samplers).toEqual(['source', 'mask']);
  });

  it('includes at least one transition', () => {
    const registry = createEffectRegistry(BUILTIN_EFFECTS);
    expect(registry.available().some((entry) => entry.manifest.category === 'transition')).toBe(true);
  });

  it('gives every built-in a name and a group, so the menu is usable', () => {
    const registry = createEffectRegistry(BUILTIN_EFFECTS);
    for (const entry of registry.available()) {
      expect(entry.manifest.name.length).toBeGreaterThan(0);
      expect(entry.manifest.group).toBeDefined();
    }
  });

  it('gives every built-in parameter a usable default', () => {
    const registry = createEffectRegistry(BUILTIN_EFFECTS);
    for (const entry of registry.available()) {
      const defaults = defaultParams(entry.manifest);
      expect(Object.keys(defaults)).toHaveLength(entry.manifest.params.length);
    }
  });
});
