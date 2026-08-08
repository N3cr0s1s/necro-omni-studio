import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generatorId } from '@nos/core';
import type { GraphLiteral } from '../contracts/introspection.js';
import type { GeneratorManifest } from '../contracts/manifest.js';
import {
  type ManifestDraft,
  addOutput,
  addParam,
  demote,
  draftHasErrors,
  editParam,
  emptyDraft,
  fromManifest,
  promote,
  suggestKey,
  suggestType,
  toManifest,
  validateDraft,
} from './manifest-draft.js';

/**
 * The draft is exercised against the **real** graphs supplied with the project.
 *
 * A hand-written literal list would only prove the draft is self-consistent. Promoting inputs discovered in
 * `audio_stable_audio_3_medium_base.json` proves that a user working from that graph can reach the manifest
 * `interfaces.md` prints for it — which is the whole claim of §5.9.
 */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const audioGraph: Record<string, { class_type?: string; inputs?: Record<string, unknown> }> = JSON.parse(
  readFileSync(`${repoRoot}/docs/comfy/audio_stable_audio_3_medium_base.json`, 'utf8'),
);

/** A local copy of the backend's literal collection, so this package stays backend-free. */
function collectLiterals(graph: typeof audioGraph): readonly GraphLiteral[] {
  const literals: GraphLiteral[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value)) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      literals.push({
        pointer: `/${nodeId}/inputs/${input}`,
        nodeId,
        nodeClass: node.class_type ?? 'unknown',
        input,
        value,
      });
    }
  }
  return literals;
}

const literals = collectLiterals(audioGraph);
const literalAt = (pointer: string): GraphLiteral => {
  const found = literals.find((literal) => literal.pointer === pointer);
  if (found === undefined) throw new Error(`the real graph has no ${pointer}`);
  return found;
};

const literal = (overrides: Partial<GraphLiteral> = {}): GraphLiteral => ({
  pointer: '/1/inputs/steps',
  nodeId: '1',
  nodeClass: 'KSampler',
  input: 'steps',
  value: 20,
  ...overrides,
});

describe('type suggestion', () => {
  it('reads the type from the value the graph carries', () => {
    expect(suggestType(literal({ value: 20 }))).toBe('int');
    expect(suggestType(literal({ value: 7.5 }))).toBe('float');
    expect(suggestType(literal({ value: true }))).toBe('bool');
    expect(suggestType(literal({ value: 'a drone' }))).toBe('text');
  });

  it('recognizes a seed by name, since the value cannot say so', () => {
    // Getting this wrong silently disables variants: the planner looks for a `seed` parameter and finds an
    // int instead, so every "variant" comes back identical.
    for (const input of ['seed', 'noise_seed', 'rand_seed']) {
      expect(suggestType(literal({ input, value: 12345 }))).toBe('seed');
    }
  });

  it('suggests seed for the real graph´s sampler seed', () => {
    expect(suggestType(literalAt('/52:3/inputs/seed'))).toBe('seed');
  });
});

describe('key suggestion', () => {
  it('uses the input name', () => {
    expect(suggestKey(literal({ input: 'steps' }), [])).toBe('steps');
  });

  it('disambiguates with the node id when two nodes share an input name', () => {
    // Two KSamplers both have `steps`; a colliding key would silently drop one binding.
    expect(suggestKey(literal({ input: 'steps', nodeId: '52:3' }), ['steps'])).toBe('steps_52_3');
  });

  it('keeps counting when even that collides', () => {
    expect(suggestKey(literal({ input: 'steps', nodeId: '3' }), ['steps', 'steps_3'])).toBe('steps_3_2');
  });

  it('sanitizes a name that is not a usable key', () => {
    expect(suggestKey(literal({ input: 'CFG Scale' }), [])).toBe('cfg_scale');
  });
});

describe('promoting literals', () => {
  it('fills in everything the inspector can infer', () => {
    const draft = promote(emptyDraft(), literalAt('/52:36/inputs/value'));
    expect(draft.params).toHaveLength(1);
    expect(draft.params[0]).toMatchObject({ pointer: '/52:36/inputs/value', key: 'value' });
  });

  it('makes the graph´s current value the default, so a fresh manifest runs as the graph did', () => {
    const source = literalAt('/52:3/inputs/steps');
    const draft = promote(emptyDraft(), source);
    expect(draft.params[0]?.default).toBe(source.value);
  });

  it('does not default a seed, which would make every run identical', () => {
    const draft = promote(emptyDraft(), literalAt('/52:3/inputs/seed'));
    expect(draft.params[0]).toMatchObject({ type: 'seed' });
    expect(draft.params[0]?.default).toBeUndefined();
  });

  it('marks a multi-line string as multiline', () => {
    const draft = promote(emptyDraft(), literal({ input: 'text', value: 'one\ntwo' }));
    expect(draft.params[0]?.multiline).toBe(true);
  });

  it('promotes the same literal only once', () => {
    const once = promote(emptyDraft(), literal());
    expect(promote(once, literal())).toBe(once);
  });

  it('demotes without touching anything else', () => {
    const draft = promote(
      promote(emptyDraft(), literal()),
      literal({ pointer: '/2/inputs/cfg', input: 'cfg' }),
    );
    const after = demote(draft, '/1/inputs/steps');
    expect(after.params.map((param) => param.key)).toEqual(['cfg']);
  });
});

describe('editing a parameter', () => {
  const draft = promote(emptyDraft(), literal({ input: 'duration', value: 50 }));

  it('applies a change', () => {
    const edited = editParam(draft, '/1/inputs/steps', { type: 'float', min: 1, max: 60 });
    expect(edited.params[0]).toMatchObject({ type: 'float', min: 1, max: 60 });
  });

  it('drops a field the user cleared rather than writing an empty one', () => {
    // A cleared range must vanish from the manifest; `"min": undefined` would serialize as null and the
    // schema would reject the file the inspector just wrote.
    const withRange = editParam(draft, '/1/inputs/steps', { min: 1 });
    const cleared = editParam(withRange, '/1/inputs/steps', { min: undefined });
    expect('min' in (cleared.params[0] ?? {})).toBe(false);
  });

  it('leaves other parameters alone', () => {
    const two = promote(draft, literal({ pointer: '/2/inputs/cfg', input: 'cfg', value: 7 }));
    const edited = editParam(two, '/2/inputs/cfg', { max: 20 });
    expect(edited.params[0]?.max).toBeUndefined();
  });
});

describe('parameters with no graph binding', () => {
  it('keeps two unbound parameters separately editable', () => {
    // The identity cannot be the pointer: the spec writes manifests before their graphs exist, and two
    // parameters with no pointer would then be the same parameter.
    const draft = addParam(addParam(emptyDraft(), { key: 'script', type: 'text' }), {
      key: 'voice',
      type: 'audio',
    });

    const edited = editParam(draft, draft.params[1]!.id, { key: 'voice_reference' });
    expect(edited.params.map((param) => param.key)).toEqual(['script', 'voice_reference']);
  });

  it('stays editable after its pointer is cleared', () => {
    const draft = promote(emptyDraft(), literal());
    const unbound = editParam(draft, '/1/inputs/steps', { pointer: '' });
    expect(editParam(unbound, '/1/inputs/steps', { key: 'renamed' }).params[0]?.key).toBe('renamed');
  });

  it('produces the same draft for the same sequence of edits', () => {
    // Ids derived from a counter rather than a clock or a random value, so a draft is reproducible and
    // diffable.
    const build = (): ManifestDraft => addParam(emptyDraft(), { key: 'script', type: 'text' });
    expect(build()).toEqual(build());
  });
});

describe('validation', () => {
  const usable = (): ManifestDraft =>
    addOutput(emptyDraft({ id: 'stable_audio_3', name: 'Stable Audio 3', graph: 'audio.json' }), {
      key: 'audio',
      type: 'audio',
      node: '57',
    });

  it('accepts a complete draft', () => {
    expect(draftHasErrors(usable())).toBe(false);
  });

  it('requires an id, a name and an output', () => {
    const paths = validateDraft(emptyDraft())
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['/id', '/name', '/outputs']));
  });

  it('rejects an id that would not survive a filename or a URL', () => {
    expect(validateDraft(usable()).some((issue) => issue.path === '/id')).toBe(false);
    const bad = { ...usable(), id: 'Stable Audio!' };
    expect(validateDraft(bad).some((issue) => issue.path === '/id' && issue.severity === 'error')).toBe(true);
  });

  it('rejects duplicate parameter keys', () => {
    const draft = editParam(
      promote(promote(usable(), literal()), literal({ pointer: '/2/inputs/steps' })),
      '/2/inputs/steps',
      { key: 'steps' },
    );
    expect(validateDraft(draft).some((issue) => issue.message.includes('duplicate'))).toBe(true);
  });

  it('rejects an inverted range', () => {
    const draft = editParam(promote(usable(), literal()), '/1/inputs/steps', { min: 10, max: 2 });
    expect(validateDraft(draft).some((issue) => issue.path.endsWith('/min'))).toBe(true);
  });

  it('rejects an enum with no options', () => {
    const draft = editParam(promote(usable(), literal()), '/1/inputs/steps', { type: 'enum' });
    expect(validateDraft(draft).some((issue) => issue.path.endsWith('/options'))).toBe(true);
  });

  it('rejects a second seed parameter', () => {
    const draft = promote(
      promote(usable(), literal({ input: 'seed', pointer: '/1/inputs/seed' })),
      literal({ input: 'noise_seed', pointer: '/2/inputs/noise_seed' }),
    );
    expect(validateDraft(draft).some((issue) => issue.message.includes('one seed'))).toBe(true);
  });

  it('warns rather than blocks when a variant count cannot be honoured', () => {
    const draft = { ...usable(), defaultVariants: 3 };
    const issue = validateDraft(draft).find((entry) => entry.path === '/defaultVariants');
    expect(issue?.severity).toBe('warning');
    expect(draftHasErrors(draft)).toBe(false);
  });

  it('lets an unbound draft be saved, because the spec writes manifests before graphs', () => {
    // Blocking this would break the workflow the registry's `unbound` status exists for.
    const unbound = { ...usable(), graph: null };
    expect(draftHasErrors(unbound)).toBe(false);
    expect(validateDraft(unbound).some((issue) => issue.path === '/graph')).toBe(true);
  });

  it('warns about a generator with no surface, which would have no entry point', () => {
    expect(validateDraft(usable()).some((issue) => issue.path === '/surfaces')).toBe(true);
  });
});

describe('writing the manifest', () => {
  const draft = (): ManifestDraft =>
    addOutput(
      emptyDraft({
        id: 'stable_audio_3',
        name: 'Stable Audio 3',
        graph: 'audio_stable_audio_3_medium_base.json',
        produces: 'audio',
        surfaces: ['media_browser'],
        defaultVariants: 3,
      }),
      { key: 'audio', type: 'audio', node: '57' },
    );

  it('binds each parameter to the pointer it came from', () => {
    const manifest = toManifest(promote(draft(), literalAt('/52:3/inputs/seed')));
    expect(manifest.params[0]).toMatchObject({ type: 'seed', bind: '/52:3/inputs/seed' });
  });

  it('produces a manifest the registry treats as available, not unbound', () => {
    const manifest = toManifest(promote(draft(), literalAt('/52:31/inputs/value')));
    expect(manifest.status).toBeUndefined();
  });

  it('marks a draft with an unbound parameter as unbound', () => {
    // The registry must grey it with "graph not connected" rather than report it broken.
    const withEmpty = editParam(promote(draft(), literal()), '/1/inputs/steps', { pointer: '' });
    const manifest = toManifest(withEmpty);
    expect(manifest.status).toBe('unbound');
    expect(manifest.params[0]?.bind).toBeNull();
  });

  it('marks a draft with no graph as unbound', () => {
    expect(toManifest({ ...draft(), graph: null }).status).toBe('unbound');
  });

  it('omits fields the user never set, so the file stays readable', () => {
    const manifest = toManifest(draft());
    expect('batch' in manifest).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain('null,');
  });

  it('survives a JSON round trip', () => {
    // This is what actually reaches disk, so anything unserializable would only surface after a restart.
    const manifest = toManifest(promote(draft(), literalAt('/52:36/inputs/value')));
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});

describe('round tripping an authored manifest', () => {
  const authored: GeneratorManifest = {
    id: generatorId('minimax_h3_i2v'),
    name: 'MiniMax H3 i2v',
    backend: 'comfyui',
    graph: 'video_minimax_h3_i2v.json',
    produces: 'video',
    consumes: [{ type: 'image', role: 'first_frame', required: true }],
    surfaces: ['frame_context_menu'],
    duration: 'declared',
    durationFrom: { param: 'duration_s', unit: 'seconds' },
    defaultVariants: 1,
    requires: ['MiniMaxNode'],
    outputs: [{ key: 'video', type: 'video', node: '92' }],
    params: [
      {
        key: 'first_frame',
        type: 'image',
        required: true,
        bind: '/114/inputs/image',
        transport: 'upload_image',
      },
      { key: 'duration_s', type: 'float', min: 0.5, max: 30, default: 15, bind: '/105:111/inputs/value' },
      {
        key: 'fps',
        type: 'int',
        default: 25,
        bind: '/105:110/inputs/value',
        // The spec's own `also` example, copied from the project's real MiniMax manifests: `fps` is
        // both a literal and part of a length expression, and a round trip that kept only the first
        // left the expression stale and delivered a clip of the wrong duration.
        also: [
          {
            pointer: '/105:107/inputs/expression',
            template: 'max(5, round(a * {fps}))',
          },
        ],
      },
      {
        key: 'width',
        type: 'int',
        default: 1280,
        bind: '/105:20/inputs/width',
        defaultFrom: 'project_width',
      },
      { key: 'seed', type: 'seed', bind: '/105:15/inputs/noise_seed' },
    ],
    presets: [],
  };

  it('reaches the same manifest again, so editing does not degrade a file', () => {
    // An inspector that lost `transport` or a range on every open would quietly break manifests people
    // already rely on.
    expect(toManifest(fromManifest(authored))).toEqual(authored);
  });

  it('keeps the secondary bindings, which are what a length expression depends on', () => {
    // Named separately from the equality check above because this is the field that was actually being
    // dropped, and a failure here should say what broke rather than diffing a whole manifest.
    const fps = toManifest(fromManifest(authored)).params.find((param) => param.key === 'fps');
    expect(fps?.also).toEqual([
      { pointer: '/105:107/inputs/expression', template: 'max(5, round(a * {fps}))' },
    ]);
  });

  it('keeps which parameter carries the declared length', () => {
    // Without it `durationSource` falls back to a key convention, so a length parameter named anything
    // else sizes every placeholder from the fallback.
    expect(toManifest(fromManifest(authored)).durationFrom).toEqual({
      param: 'duration_s',
      unit: 'seconds',
    });
  });

  it('keeps a default that is derived rather than fixed', () => {
    const width = toManifest(fromManifest(authored)).params.find((param) => param.key === 'width');
    expect(width?.defaultFrom).toBe('project_width');
  });

  it('recovers an unbound manifest as an editable draft', () => {
    const unbound: GeneratorManifest = {
      ...authored,
      graph: null,
      status: 'unbound',
      params: [{ key: 'script', type: 'text', bind: null }],
    };
    const draft = fromManifest(unbound);
    expect(draft.params[0]?.pointer).toBe('');
    expect(toManifest(draft).status).toBe('unbound');
  });
});
