import { describe, expect, it } from 'vitest';
import { assetPath, generatorId } from '@nos/core';
import type { GeneratorManifest, GeneratorParam } from '../contracts/manifest.js';
import {
  type AssetChoice,
  assetParams,
  choicesFor,
  describeBlockers,
  isAssetParam,
  runBlockers,
} from './asset-inputs.js';

function param(overrides: Partial<GeneratorParam> & Pick<GeneratorParam, 'key' | 'type'>): GeneratorParam {
  return { bind: `/1/inputs/${overrides.key}`, ...overrides };
}

function manifest(params: readonly GeneratorParam[]): GeneratorManifest {
  return {
    id: generatorId('i2v'),
    name: 'image to video',
    backend: 'comfyui',
    graph: 'g.json',
    produces: 'video',
    consumes: [{ type: 'image', role: 'first_frame', required: true }],
    surfaces: [],
    duration: 'declared',
    defaultVariants: 1,
    requires: [],
    outputs: [],
    params,
    presets: [],
  };
}

const choices: readonly AssetChoice[] = [
  { path: assetPath('media/shot.mp4'), label: 'shot.mp4', type: 'video' },
  { path: assetPath('media/frame.png'), label: 'frame.png', type: 'image' },
  { path: assetPath('media/vo.wav'), label: 'vo.wav', type: 'audio' },
  { path: assetPath('masks/sky.png'), label: 'sky.png', type: 'mask' },
];

describe('asset parameters', () => {
  it('recognises the parameter types that name a file', () => {
    expect(isAssetParam(param({ key: 'a', type: 'image' }))).toBe(true);
    expect(isAssetParam(param({ key: 'a', type: 'audio' }))).toBe(true);
    expect(isAssetParam(param({ key: 'a', type: 'text' }))).toBe(false);
    expect(isAssetParam(param({ key: 'a', type: 'seed' }))).toBe(false);
  });

  it('lists a manifest’s asset parameters in declaration order', () => {
    const found = assetParams(
      manifest([
        param({ key: 'first_frame', type: 'image' }),
        param({ key: 'prompt', type: 'text' }),
        param({ key: 'voice', type: 'audio' }),
      ]),
    );
    expect(found.map((entry) => entry.key)).toEqual(['first_frame', 'voice']);
  });
});

describe('what may be offered for a parameter', () => {
  it('offers only files of the declared type', () => {
    const offered = choicesFor(param({ key: 'first_frame', type: 'image' }), choices);
    expect(offered.map((entry) => entry.label)).toEqual(['frame.png']);
  });

  it('offers an image for a mask parameter, since a mask is one', () => {
    // The project separates them by folder, not by format. Refusing a painted PNG because it was
    // saved outside `masks/` would deny a file the user is looking straight at.
    const offered = choicesFor(param({ key: 'mask', type: 'mask' }), choices);
    expect(offered.map((entry) => entry.label)).toEqual(['frame.png', 'sky.png']);
  });

  it('offers nothing for a parameter that does not name a file', () => {
    expect(choicesFor(param({ key: 'prompt', type: 'text' }), choices)).toEqual([]);
  });
});

describe('what blocks a run', () => {
  it('is nothing when the generator is available and its required inputs are set', () => {
    const blockers = runBlockers({
      manifest: manifest([param({ key: 'first_frame', type: 'image', required: true })]),
      status: 'available',
      values: { first_frame: 'media/frame.png' },
    });
    expect(blockers).toEqual([]);
    expect(describeBlockers(blockers)).toBeUndefined();
  });

  it('names the required input that has no value', () => {
    // The bug this exists for: the panel showed `first frame — not set`, offered no way to set it,
    // and left `Generate` enabled, so the graph ran with an empty image slot.
    const blockers = runBlockers({
      manifest: manifest([
        param({ key: 'first_frame', type: 'image', label: 'First frame', required: true }),
      ]),
      status: 'available',
      values: {},
    });
    expect(blockers).toEqual([
      { kind: 'missing-input', param: 'first_frame', message: 'First frame is required' },
    ]);
  });

  it('treats an empty string as unset, because a placeholder option produces one', () => {
    const blockers = runBlockers({
      manifest: manifest([param({ key: 'first_frame', type: 'image', required: true })]),
      status: 'available',
      values: { first_frame: '' },
    });
    expect(blockers).toHaveLength(1);
  });

  it('accepts a falsy value that is a real answer', () => {
    // `0` and `false` are values. Testing truthiness here would make a required number impossible to
    // satisfy with the very value a user most often wants.
    const blockers = runBlockers({
      manifest: manifest([
        param({ key: 'strength', type: 'float', required: true }),
        param({ key: 'upscale', type: 'bool', required: true }),
      ]),
      status: 'available',
      values: { strength: 0, upscale: false },
    });
    expect(blockers).toEqual([]);
  });

  it('ignores parameters that are not required', () => {
    const blockers = runBlockers({
      manifest: manifest([param({ key: 'first_frame', type: 'image' })]),
      status: 'available',
      values: {},
    });
    expect(blockers).toEqual([]);
  });

  it('reports the backend problem alongside the missing inputs, not instead of them', () => {
    const blockers = runBlockers({
      manifest: manifest([param({ key: 'first_frame', type: 'image', required: true })]),
      status: 'unbound',
      values: {},
    });
    expect(blockers.map((entry) => entry.kind)).toEqual(['unbound', 'missing-input']);
  });

  it('reports every missing input at once', () => {
    // One per attempt would turn setting up a generator into a guessing game.
    const blockers = runBlockers({
      manifest: manifest([
        param({ key: 'first_frame', type: 'image', label: 'First frame', required: true }),
        param({ key: 'prompt', type: 'text', label: 'Prompt', required: true }),
      ]),
      status: 'available',
      values: {},
    });
    expect(blockers).toHaveLength(2);
    expect(describeBlockers(blockers)).toBe('First frame is required, and 1 more');
  });
});
