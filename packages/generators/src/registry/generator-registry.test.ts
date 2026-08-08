import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generatorId, presetId } from '@nos/core';
import type { GeneratorManifest } from '../contracts/manifest.js';
import {
  createGeneratorRegistry,
  describeRecord,
  isEntryRunnable,
  validateManifest,
} from './generator-registry.js';

/**
 * The real ComfyUI graphs supplied with the project.
 *
 * Validating the spec's own example manifests against these is the strongest available test of the
 * manifest layer: it proves the pointer format, the node-id conventions and the output declarations are
 * right against files nobody wrote for the test.
 */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

function loadGraph(name: string): unknown {
  return JSON.parse(readFileSync(`${repoRoot}/docs/comfy/${name}.json`, 'utf8'));
}

const audioGraph = loadGraph('audio_stable_audio_3_medium_base');
const i2vGraph = loadGraph('video_minimax_h3_i2v');

/** The Stable Audio manifest exactly as `interfaces.md` §2.1 writes it. */
const stableAudio: GeneratorManifest = {
  id: generatorId('stable_audio_3'),
  name: 'Stable Audio 3',
  backend: 'comfyui',
  graph: 'audio_stable_audio_3_medium_base.json',
  produces: 'audio',
  consumes: [],
  surfaces: ['media_browser', 'audio_track_empty'],
  duration: 'declared',
  defaultVariants: 3,
  batch: { bind: '/52:11/inputs/batch_size', max: 4 },
  requires: [
    'CheckpointLoaderSimple',
    'EmptyLatentAudio',
    'CustomCombo',
    'JsonExtractString',
    'TextGenerate',
    'ComfySwitchNode',
    'SaveAudioAdvanced',
  ],
  outputs: [{ key: 'audio', type: 'audio', node: '57' }],
  params: [
    { key: 'description', label: 'Leírás', type: 'text', multiline: true, bind: '/52:31/inputs/value' },
    {
      key: 'category',
      label: 'Kategória',
      type: 'enum',
      options: ['Music', 'Instrument', 'SFX', 'One-shot'],
      default: 'Music',
      bind: '/52:43/inputs/choice',
    },
    { key: 'duration_s', label: 'Hossz (s)', type: 'float', min: 1, step: 1, default: 50, bind: '/52:36/inputs/value' },
    { key: 'enhance_prompt', type: 'bool', default: false, bind: '/52:35/inputs/value' },
    { key: 'negative', type: 'text', default: '', bind: '/52:7/inputs/text' },
    { key: 'seed', type: 'seed', bind: '/52:3/inputs/seed' },
    { key: 'steps', type: 'int', min: 1, max: 100, default: 50, bind: '/52:3/inputs/steps' },
    { key: 'cfg', type: 'float', min: 1, max: 15, step: 0.5, default: 7, bind: '/52:3/inputs/cfg' },
  ],
  presets: [
    { id: presetId('music'), name: 'Zene', pin: { category: 'Music' } },
    { id: presetId('instrumental'), name: 'Instrumentális', pin: { category: 'Instrument' } },
    { id: presetId('sfx'), name: 'SFX', pin: { category: 'SFX', duration_s: 5 } },
    { id: presetId('oneshot'), name: 'One-shot', pin: { category: 'One-shot', duration_s: 2 } },
  ],
};

/** The image-to-video manifest from `interfaces.md` §2.2, including its `also` template. */
const minimaxI2v: GeneratorManifest = {
  id: generatorId('minimax_h3_i2v'),
  name: 'MiniMax H3 image to video',
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
    { key: 'first_frame', type: 'image', required: true, bind: '/114/inputs/image', transport: 'upload_image' },
    { key: 'prompt', type: 'text', multiline: true, bind: '/105:104/inputs/prompt' },
    { key: 'duration_s', type: 'float', min: 0.5, max: 30, default: 15, bind: '/105:111/inputs/value' },
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

const context = (overrides: Partial<Parameters<typeof validateManifest>[1]> = {}) => ({
  graphs: new Map<string, unknown>([
    ['audio_stable_audio_3_medium_base.json', audioGraph],
    ['video_minimax_h3_i2v.json', i2vGraph],
  ]),
  backends: new Set(['comfyui']),
  ...overrides,
});

describe('the spec example manifests against the real graphs', () => {
  it('validates the Stable Audio manifest as available', () => {
    const record = validateManifest(stableAudio, context());
    // If this fails, either a pointer in the spec's own example is wrong or our resolver is.
    expect(record.reasons).toEqual([]);
    expect(record.status).toBe('available');
  });

  it('validates the image-to-video manifest, including its also pointer', () => {
    const record = validateManifest(minimaxI2v, context());
    expect(record.reasons).toEqual([]);
    expect(record.status).toBe('available');
  });

  it('checks required node classes against what the backend reports', () => {
    const installed = new Set(['CheckpointLoaderSimple']);
    const record = validateManifest(stableAudio, context({ installedNodeClasses: installed }));
    expect(record.status).toBe('unavailable');
    expect(record.reasons.filter((reason) => reason.kind === 'node-class-missing').length).toBe(6);
  });

  it('passes when every required node class is installed', () => {
    const record = validateManifest(
      stableAudio,
      context({ installedNodeClasses: new Set(stableAudio.requires) }),
    );
    expect(record.status).toBe('available');
  });
});

describe('unavailable reasons', () => {
  it('names a broken pointer and how far it got', () => {
    // The spec requires the broken pointer to be named; "where is my tool" debugging otherwise costs hours.
    const broken: GeneratorManifest = {
      ...stableAudio,
      params: [{ key: 'x', type: 'text', bind: '/52:3/inputs/does_not_exist' }],
    };
    const record = validateManifest(broken, context());
    expect(record.status).toBe('unavailable');
    expect(describeRecord(record)).toContain('does_not_exist');
    expect(describeRecord(record)).toContain('/52:3/inputs');
  });

  it('reports every broken pointer, not only the first', () => {
    // Three broken pointers should be three reports, or fixing them is three reload cycles.
    const broken: GeneratorManifest = {
      ...stableAudio,
      params: [
        { key: 'a', type: 'text', bind: '/nope/inputs/x' },
        { key: 'b', type: 'text', bind: '/also-nope/inputs/y' },
        { key: 'c', type: 'text', bind: '/52:3/inputs/missing' },
      ],
    };
    expect(validateManifest(broken, context()).reasons).toHaveLength(3);
  });

  it('reports a missing graph file', () => {
    const record = validateManifest({ ...stableAudio, graph: 'absent.json' }, context());
    expect(record.reasons[0]).toEqual({ kind: 'graph-missing', graph: 'absent.json' });
    expect(describeRecord(record)).toContain('was not found');
  });

  it('reports an output naming a node the graph does not contain', () => {
    const record = validateManifest(
      { ...stableAudio, outputs: [{ key: 'audio', type: 'audio', node: '999' }] },
      context(),
    );
    expect(record.status).toBe('unavailable');
    expect(describeRecord(record)).toContain('999');
  });

  it('reports an unknown backend', () => {
    const record = validateManifest({ ...stableAudio, backend: 'invoke' }, context());
    expect(record.reasons.some((reason) => reason.kind === 'unknown-backend')).toBe(true);
  });

  it('reports a broken also pointer, which a single-pointer check would miss', () => {
    // The `also` mechanism exists because one value must reach several places; an unchecked one leaves an
    // expression stale and produces a clip of the wrong duration.
    const broken: GeneratorManifest = {
      ...minimaxI2v,
      params: minimaxI2v.params.map((param) =>
        param.key === 'fps'
          ? { ...param, also: [{ pointer: '/105:107/inputs/not_there', template: '{fps}' }] }
          : param,
      ),
    };
    const record = validateManifest(broken, context());
    expect(record.status).toBe('unavailable');
    expect(describeRecord(record)).toContain('not_there');
  });

  it('reports a broken batch pointer', () => {
    const record = validateManifest(
      { ...stableAudio, batch: { bind: '/52:11/inputs/nope', max: 4 } },
      context(),
    );
    expect(record.status).toBe('unavailable');
  });
});

describe('unbound manifests', () => {
  /** The TTS contract from `interfaces.md` §2.3: written before its graph exists. */
  const tts: GeneratorManifest = {
    id: generatorId('tts'),
    name: 'Text to speech',
    backend: 'comfyui',
    graph: null,
    status: 'unbound',
    produces: 'audio',
    consumes: [
      { type: 'text', role: 'script', required: true, sources: ['inline', 'notes_file', 'text_clip'] },
      { type: 'audio', role: 'voice_reference', required: false },
    ],
    surfaces: ['media_browser', 'audio_track_empty', 'text_clip_context_menu'],
    duration: 'discovered',
    defaultVariants: 1,
    requires: [],
    outputs: [
      { key: 'audio', type: 'audio', node: null },
      { key: 'alignment', type: 'text', node: null, format: 'word_timings', optional: true },
    ],
    params: [
      { key: 'script', type: 'text', multiline: true, bind: null },
      { key: 'voice', type: 'enum', bind: null, options: { from: 'capabilities' } },
      { key: 'seed', type: 'seed', bind: null },
    ],
    presets: [],
  };

  it('is unbound, not unavailable — nothing is broken, the work is not done', () => {
    // Different user response: one is a to-do, the other is a bug.
    const record = validateManifest(tts, context());
    expect(record.status).toBe('unbound');
    expect(record.reasons).toEqual([]);
  });

  it('says the graph is not connected rather than listing null pointers', () => {
    // Reporting every null bind would bury the one fact that matters.
    expect(describeRecord(validateManifest(tts, context()))).toContain('not connected');
  });

  it('detects an unbound manifest from a null bind even without the status field', () => {
    const { status, ...withoutStatus } = tts;
    void status;
    expect(validateManifest(withoutStatus as GeneratorManifest, context()).status).toBe('unbound');
  });

  it('still contributes its UI entries, so the tool is visible', () => {
    expect(validateManifest(tts, context()).entries).toHaveLength(1);
  });
});

describe('registry', () => {
  const registry = () =>
    createGeneratorRegistry([stableAudio, minimaxI2v], context({ installedNodeClasses: new Set(stableAudio.requires) }));

  it('lists available generators', () => {
    expect(registry().available()).toHaveLength(2);
  });

  it('finds a manifest by id', () => {
    expect(registry().manifestFor(generatorId('stable_audio_3'))?.name).toBe('Stable Audio 3');
  });

  it('contributes one entry per preset, so one graph becomes several tools', () => {
    // The spec's audio example becomes music, instrumental, SFX and one-shot from one graph.
    const record = registry().find(generatorId('stable_audio_3'))!;
    expect(record.entries.map((entry) => entry.label)).toEqual([
      'Zene',
      'Instrumentális',
      'SFX',
      'One-shot',
    ]);
  });

  it('contributes a single entry when there are no presets', () => {
    expect(registry().find(generatorId('minimax_h3_i2v'))!.entries).toHaveLength(1);
  });

  it('places entries by declared surface', () => {
    const menu = registry().entriesForSurface('frame_context_menu');
    expect(menu.map((entry) => entry.generator)).toEqual(['minimax_h3_i2v']);
  });

  it('keeps unavailable entries on their surface, greyed rather than hidden', () => {
    // Filtering them out is exactly the disappearing-tool behaviour the spec forbids.
    const withBroken = createGeneratorRegistry(
      [{ ...stableAudio, graph: 'missing.json' }],
      context(),
    );
    const entries = withBroken.entriesForSurface('media_browser');
    expect(entries.length).toBeGreaterThan(0);
    expect(isEntryRunnable(withBroken, entries[0]!)).toBe(false);
  });

  it('reports problems separately for a diagnostics panel', () => {
    const mixed = createGeneratorRegistry([stableAudio, { ...minimaxI2v, backend: 'nope' }], context());
    expect(mixed.available()).toHaveLength(1);
    expect(mixed.problems()).toHaveLength(1);
  });

  it('lets a later manifest shadow an earlier one with the same id', () => {
    const shadowed = createGeneratorRegistry(
      [stableAudio, { ...stableAudio, name: 'Project override' }],
      context(),
    );
    expect(shadowed.manifestFor(generatorId('stable_audio_3'))?.name).toBe('Project override');
  });

  it('resolves a preset by id', () => {
    expect(registry().presetFor(generatorId('stable_audio_3'), presetId('sfx'))?.name).toBe('SFX');
  });

  it('does not check requirements before the backend has reported', () => {
    // Greying out every generator while the backend starts would be worse than briefly optimistic.
    const early = createGeneratorRegistry([stableAudio], context());
    expect(early.available()).toHaveLength(1);
  });
});
