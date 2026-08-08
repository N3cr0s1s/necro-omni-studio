import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generatorId, presetId } from '@nos/core';
import type { GeneratorManifest } from '@nos/generators';
import { PatchError, collectLiterals, patchGraph, patchUploadedAsset, readLiteral } from './graph-patcher.js';

/**
 * Patching is verified against the **real** graphs supplied with the project.
 *
 * A hand-written fixture would only prove the patcher is self-consistent. Writing into
 * `audio_stable_audio_3_medium_base.json` and reading the value back out proves the pointer format, the
 * node-id convention and the patch itself against a file nobody wrote for the test.
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const loadGraph = (name: string): unknown =>
  JSON.parse(readFileSync(`${repoRoot}/docs/comfy/${name}.json`, 'utf8'));

const audioGraph = loadGraph('audio_stable_audio_3_medium_base');
const i2vGraph = loadGraph('video_minimax_h3_i2v');

/** The Stable Audio manifest from `interfaces.md` §2.1. */
const stableAudio: GeneratorManifest = {
  id: generatorId('stable_audio_3'),
  name: 'Stable Audio 3',
  backend: 'comfyui',
  graph: 'audio_stable_audio_3_medium_base.json',
  produces: 'audio',
  consumes: [],
  surfaces: ['media_browser'],
  duration: 'declared',
  defaultVariants: 3,
  batch: { bind: '/52:11/inputs/batch_size', max: 4 },
  requires: [],
  outputs: [{ key: 'audio', type: 'audio', node: '57' }],
  params: [
    { key: 'description', type: 'text', multiline: true, bind: '/52:31/inputs/value' },
    {
      key: 'category',
      type: 'enum',
      options: ['Music', 'Instrument', 'SFX', 'One-shot'],
      default: 'Music',
      bind: '/52:43/inputs/choice',
    },
    { key: 'duration_s', type: 'float', default: 50, bind: '/52:36/inputs/value' },
    { key: 'enhance_prompt', type: 'bool', default: false, bind: '/52:35/inputs/value' },
    { key: 'negative', type: 'text', default: '', bind: '/52:7/inputs/text' },
    { key: 'seed', type: 'seed', bind: '/52:3/inputs/seed' },
    { key: 'steps', type: 'int', default: 50, bind: '/52:3/inputs/steps' },
    { key: 'cfg', type: 'float', default: 7, bind: '/52:3/inputs/cfg' },
  ],
  presets: [
    { id: presetId('sfx'), name: 'SFX', pin: { category: 'SFX', duration_s: 5 } },
    { id: presetId('oneshot'), name: 'One-shot', pin: { category: 'One-shot', duration_s: 2 } },
  ],
};

/** The image-to-video manifest from §2.2, with its `also` template. */
const minimaxI2v: GeneratorManifest = {
  id: generatorId('minimax_h3_i2v'),
  name: 'MiniMax H3 i2v',
  backend: 'comfyui',
  graph: 'video_minimax_h3_i2v.json',
  produces: 'video',
  consumes: [{ type: 'image', role: 'first_frame', required: true }],
  surfaces: ['frame_context_menu'],
  duration: 'declared',
  defaultVariants: 1,
  requires: [],
  outputs: [{ key: 'video', type: 'video', node: '92' }],
  params: [
    {
      key: 'first_frame',
      type: 'image',
      required: true,
      bind: '/114/inputs/image',
      transport: 'upload_image',
    },
    { key: 'prompt', type: 'text', bind: '/105:104/inputs/prompt' },
    { key: 'duration_s', type: 'float', default: 15, bind: '/105:111/inputs/value' },
    { key: 'seed', type: 'seed', bind: '/105:15/inputs/noise_seed' },
    {
      key: 'fps',
      type: 'int',
      default: 24,
      bind: '/105:91/inputs/fps',
      also: [
        {
          pointer: '/105:107/inputs/expression',
          template: 'max(5, round(a * {fps})) + (5 - (max(5, round(a * {fps})) % 17)) % 17',
        },
      ],
    },
  ],
  presets: [],
};

describe('patching the real audio graph', () => {
  it('writes a parameter to its pointer', () => {
    const { graph } = patchGraph({
      manifest: stableAudio,
      graph: audioGraph,
      params: { description: 'a low drone' },
      seeds: [4471],
    });
    expect(readLiteral(graph, '/52:31/inputs/value')).toBe('a low drone');
  });

  it('writes the seed the queue supplied', () => {
    // Variants come from varying the seed, so a seed that fails to land makes every variant identical.
    const { graph } = patchGraph({ manifest: stableAudio, graph: audioGraph, params: {}, seeds: [4471] });
    expect(readLiteral(graph, '/52:3/inputs/seed')).toBe(4471);
  });

  it('applies declared defaults for parameters the user did not set', () => {
    const { graph } = patchGraph({ manifest: stableAudio, graph: audioGraph, params: {}, seeds: [1] });
    expect(readLiteral(graph, '/52:36/inputs/value')).toBe(50);
    expect(readLiteral(graph, '/52:3/inputs/steps')).toBe(50);
  });

  it('lets a user value override a default', () => {
    const { graph } = patchGraph({
      manifest: stableAudio,
      graph: audioGraph,
      params: { duration_s: 12 },
      seeds: [1],
    });
    expect(readLiteral(graph, '/52:36/inputs/value')).toBe(12);
  });

  it('lets a preset pin win over a user value, since a preset defines rather than suggests', () => {
    const { graph } = patchGraph({
      manifest: stableAudio,
      graph: audioGraph,
      params: { category: 'Music', duration_s: 60 },
      preset: presetId('sfx'),
      seeds: [1],
    });
    expect(readLiteral(graph, '/52:43/inputs/choice')).toBe('SFX');
    expect(readLiteral(graph, '/52:36/inputs/value')).toBe(5);
  });

  it('patches batch size only when the submit carries several seeds', () => {
    const single = patchGraph({ manifest: stableAudio, graph: audioGraph, params: {}, seeds: [1] });
    const batched = patchGraph({ manifest: stableAudio, graph: audioGraph, params: {}, seeds: [1, 2, 3] });

    expect(readLiteral(single.graph, '/52:11/inputs/batch_size')).toBe(
      readLiteral(audioGraph, '/52:11/inputs/batch_size'),
    );
    expect(readLiteral(batched.graph, '/52:11/inputs/batch_size')).toBe(3);
  });

  it('does not mutate the loaded graph', () => {
    // The same parsed graph is reused for every run; a mutating patch would make the second run inherit the
    // first run's parameters — a bug that only appears once someone renders twice.
    const before = JSON.stringify(audioGraph);
    patchGraph({ manifest: stableAudio, graph: audioGraph, params: { duration_s: 99 }, seeds: [7] });
    expect(JSON.stringify(audioGraph)).toBe(before);
  });

  it('leaves untouched nodes intact', () => {
    const { graph } = patchGraph({ manifest: stableAudio, graph: audioGraph, params: {}, seeds: [1] });
    expect(readLiteral(graph, '/57/inputs/format')).toBe(readLiteral(audioGraph, '/57/inputs/format'));
    expect(Object.keys(graph as object)).toEqual(Object.keys(audioGraph as object));
  });

  it('reports the values it applied, for reproducibility', () => {
    const { appliedParams } = patchGraph({
      manifest: stableAudio,
      graph: audioGraph,
      params: { description: 'x' },
      preset: presetId('oneshot'),
      seeds: [99],
    });
    expect(appliedParams).toMatchObject({ description: 'x', category: 'One-shot', duration_s: 2, seed: 99 });
  });
});

describe('the also mechanism', () => {
  it('writes the fps value to both its literal and the expression', () => {
    // The reason `also` exists: patching only the literal leaves the length expression computing from a
    // stale rate and produces a clip of the wrong duration.
    const { graph } = patchGraph({
      manifest: minimaxI2v,
      graph: i2vGraph,
      params: { fps: 30, first_frame: 'media/frame.png' },
      seeds: [5],
    });

    expect(readLiteral(graph, '/105:91/inputs/fps')).toBe(30);
    const expression = readLiteral(graph, '/105:107/inputs/expression');
    expect(String(expression)).toContain('30');
    expect(String(expression)).not.toContain('{fps}');
  });

  it('substitutes every occurrence in the template', () => {
    const { graph } = patchGraph({
      manifest: minimaxI2v,
      graph: i2vGraph,
      params: { fps: 24, first_frame: 'media/frame.png' },
      seeds: [5],
    });
    const expression = String(readLiteral(graph, '/105:107/inputs/expression'));
    // The spec's template mentions {fps} twice.
    expect(expression.match(/24/g)?.length).toBe(2);
  });

  it('uses the default fps when the user did not set one', () => {
    const { graph } = patchGraph({
      manifest: minimaxI2v,
      graph: i2vGraph,
      params: { first_frame: 'media/frame.png' },
      seeds: [5],
    });
    expect(String(readLiteral(graph, '/105:107/inputs/expression'))).toContain('24');
  });
});

describe('asset parameters', () => {
  it('collects an asset for upload rather than patching its path', () => {
    // The graph must reference the filename the *server* assigns, which only exists after upload.
    const { assets, graph } = patchGraph({
      manifest: minimaxI2v,
      graph: i2vGraph,
      params: { first_frame: 'media/frame.png' },
      seeds: [1],
    });

    expect(assets).toEqual([{ key: 'first_frame', path: 'media/frame.png', transport: 'upload_image' }]);
    // Untouched until the upload returns.
    expect(readLiteral(graph, '/114/inputs/image')).toBe(readLiteral(i2vGraph, '/114/inputs/image'));
  });

  it('patches the uploaded filename once it is known', () => {
    const patched = patchUploadedAsset(i2vGraph, minimaxI2v, 'first_frame', 'frame_1234.png');
    expect(readLiteral(patched, '/114/inputs/image')).toBe('frame_1234.png');
  });

  it('refuses to submit when a required parameter has no value', () => {
    // Submitting anyway would silently use whatever the graph author last saved.
    expect(() => patchGraph({ manifest: minimaxI2v, graph: i2vGraph, params: {}, seeds: [1] })).toThrow(
      PatchError,
    );
  });

  it('names the offending parameter in the error', () => {
    try {
      patchGraph({ manifest: minimaxI2v, graph: i2vGraph, params: {}, seeds: [1] });
      throw new Error('expected a PatchError');
    } catch (error) {
      expect((error as PatchError).paramKey).toBe('first_frame');
    }
  });
});

describe('collectLiterals, for the manifest inspector', () => {
  it('lists literal inputs with their node class and current value', () => {
    // The spec's workflow: the inspector lists node inputs so the user ticks which become parameters.
    const literals = collectLiterals(audioGraph);
    const seed = literals.find((literal) => literal.pointer === '/52:3/inputs/seed');
    expect(seed).toBeDefined();
    expect(seed!.nodeId).toBe('52:3');
    expect(typeof seed!.value).toBe('number');
  });

  it('excludes connections, which cannot be parameters', () => {
    // An input wired to another node's output would be overwritten immediately; offering it would produce
    // manifests that patch a value the graph discards.
    const literals = collectLiterals(audioGraph);
    expect(literals.some((literal) => literal.pointer === '/57/inputs/audio')).toBe(false);
  });

  it('reports the node class, so the inspector can group by node', () => {
    const literals = collectLiterals(audioGraph);
    expect(literals.every((literal) => literal.nodeClass.length > 0)).toBe(true);
    expect(literals.some((literal) => literal.nodeClass === 'SaveAudioAdvanced')).toBe(true);
  });

  it('finds every pointer the spec manifest binds to', () => {
    // If the inspector cannot surface a pointer, a user could not have authored that manifest with it.
    const pointers = new Set(collectLiterals(audioGraph).map((literal) => literal.pointer));
    for (const param of stableAudio.params) {
      if (param.bind !== null) expect(pointers.has(param.bind)).toBe(true);
    }
  });

  it('returns nothing for a non-graph', () => {
    expect(collectLiterals(null)).toEqual([]);
    expect(collectLiterals([1, 2])).toEqual([]);
  });
});
