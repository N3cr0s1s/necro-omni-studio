import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GeneratorManifest } from '../contracts/manifest.js';
import { seedParam, supportsVariants } from '../contracts/manifest.js';
import { createGeneratorRegistry, describeRecord } from '../registry/generator-registry.js';
import { parseManifestFile, serializeManifest } from './manifest-file.js';

/**
 * The shipped generator library.
 *
 * Every manifest in `generators/` is parsed and validated against the **real** graph it names. This is the
 * test that would have caught a mistyped node id, a pointer into a connection, or a `requires` entry for a
 * node class the graph does not use — none of which a unit test on the parser can see, because they are
 * facts about files nobody wrote for the test.
 *
 * It is also the closest thing to an end-to-end check of the framework's central claim: a generative
 * capability is a JSON file. If these five files validate, five capabilities exist with no code.
 */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const libraryDir = `${repoRoot}/generators`;

const manifestFiles = readdirSync(libraryDir).filter((name) => name.endsWith('.manifest.json'));

const graphs = new Map<string, unknown>(
  readdirSync(libraryDir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.manifest.json'))
    .map((name) => [name, JSON.parse(readFileSync(`${libraryDir}/${name}`, 'utf8'))]),
);

function load(name: string): GeneratorManifest {
  const parsed = parseManifestFile(JSON.parse(readFileSync(`${libraryDir}/${name}`, 'utf8')));
  if (!parsed.ok) {
    throw new Error(`${name} did not parse: ${JSON.stringify(parsed.error, null, 2)}`);
  }
  return parsed.value;
}

const manifests = manifestFiles.map(load);

/**
 * Node classes one graph uses.
 *
 * Read from the graph itself rather than hand-listed, so `requires` is checked against what the graph
 * actually needs instead of against a copy of the same mistake.
 */
function nodeClassesOf(graph: unknown): ReadonlySet<string> {
  return new Set(
    Object.values(graph as Record<string, { class_type?: string }>)
      .map((node) => node?.class_type)
      .filter((nodeClass): nodeClass is string => typeof nodeClass === 'string'),
  );
}

/**
 * Each manifest is validated against **its own** graph's node classes.
 *
 * Deliberately not the union of every graph: a `requires` entry naming a node class that only some other
 * graph happens to use would then pass here and fail on the first run, which is exactly the class of
 * mistake this file exists to catch.
 */
const registry = createGeneratorRegistry(manifests, {
  graphs,
  installedNodeClasses: new Set(
    manifests.flatMap((manifest) => [...nodeClassesOf(graphs.get(manifest.graph ?? ''))]),
  ),
  backends: new Set(['comfyui']),
});

const registryFor = (manifest: GeneratorManifest) =>
  createGeneratorRegistry([manifest], {
    graphs,
    installedNodeClasses: nodeClassesOf(graphs.get(manifest.graph ?? '')),
    backends: new Set(['comfyui']),
  });

describe('the shipped library', () => {
  it('ships a manifest for every supplied graph', () => {
    const bound = new Set(manifests.map((manifest) => manifest.graph));
    for (const graph of graphs.keys()) expect(bound).toContain(graph);
  });

  it('parses every manifest', () => {
    expect(manifests).toHaveLength(manifestFiles.length);
    expect(manifestFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('validates every manifest against its real graph', () => {
    // The assertion that matters: every pointer resolves, every required node class is present, every
    // output node exists — checked against files written by someone else, for something else.
    const problems = registry.problems().map(describeRecord);
    expect(problems).toEqual([]);
  });

  it('requires only node classes its own graph contains', () => {
    for (const manifest of manifests) {
      expect(registryFor(manifest).problems().map(describeRecord), manifest.id).toEqual([]);
    }
  });

  it('gives every manifest a unique id', () => {
    const ids = manifests.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares a surface for every manifest, or it would have no entry point', () => {
    for (const manifest of manifests) {
      expect(manifest.surfaces.length, manifest.id).toBeGreaterThan(0);
    }
  });

  it('gives every manifest at least one output', () => {
    for (const manifest of manifests) {
      expect(manifest.outputs.length, manifest.id).toBeGreaterThan(0);
    }
  });
});

describe('manifest coherence', () => {
  it('can vary anything it claims to vary', () => {
    // A manifest asking for three variants with no seed parameter returns three identical results, and the
    // reason is invisible unless someone reads the queue's constraint note.
    for (const manifest of manifests) {
      if (manifest.defaultVariants > 1) expect(supportsVariants(manifest), manifest.id).toBe(true);
    }
  });

  it('gives every generator a seed, since variants are the point', () => {
    for (const manifest of manifests) {
      expect(seedParam(manifest), manifest.id).toBeDefined();
    }
  });

  it('sizes every declared-length manifest from a parameter it actually has', () => {
    for (const manifest of manifests) {
      if (manifest.durationFrom === undefined) continue;
      const param = manifest.params.find((entry) => entry.key === manifest.durationFrom?.param);
      expect(param, `${manifest.id} declares a length parameter it does not have`).toBeDefined();
    }
  });

  it('declares a transport for every asset parameter', () => {
    // Without one the runner has no way to get the file to the backend, and the failure appears only at
    // submit time.
    for (const manifest of manifests) {
      for (const param of manifest.params) {
        if (['image', 'video', 'audio', 'mask'].includes(param.type)) {
          expect(param.transport, `${manifest.id}/${param.key}`).toBeDefined();
        }
      }
    }
  });

  it('pins only parameters that exist, in every preset', () => {
    // A pin naming a renamed parameter silently does nothing, and the preset then behaves as the base tool.
    for (const manifest of manifests) {
      const keys = new Set(manifest.params.map((param) => param.key));
      for (const preset of manifest.presets) {
        for (const pinned of Object.keys(preset.pin)) {
          expect(keys.has(pinned), `${manifest.id}/${preset.id} pins ${pinned}`).toBe(true);
        }
      }
    }
  });

  it('keeps every declared default inside its declared range', () => {
    for (const manifest of manifests) {
      for (const param of manifest.params) {
        if (typeof param.default !== 'number') continue;
        if (param.min !== undefined)
          expect(param.default, `${manifest.id}/${param.key}`).toBeGreaterThanOrEqual(param.min);
        if (param.max !== undefined)
          expect(param.default, `${manifest.id}/${param.key}`).toBeLessThanOrEqual(param.max);
      }
    }
  });

  it('keeps every enum default among its options', () => {
    for (const manifest of manifests) {
      for (const param of manifest.params) {
        if (param.type !== 'enum' || !Array.isArray(param.options)) continue;
        if (param.default === undefined) continue;
        expect(param.options, `${manifest.id}/${param.key}`).toContain(param.default);
      }
    }
  });

  it('never binds two parameters to the same pointer', () => {
    // Both would patch the same input and the later one would silently win.
    for (const manifest of manifests) {
      const bound = manifest.params.map((param) => param.bind).filter((bind) => bind !== null);
      expect(new Set(bound).size, manifest.id).toBe(bound.length);
    }
  });
});

describe('file round trip', () => {
  it('writes back what it read, so opening a manifest does not degrade it', () => {
    for (const name of manifestFiles) {
      const manifest = load(name);
      const rewritten = parseManifestFile(serializeManifest(manifest));
      expect(rewritten.ok, name).toBe(true);
      if (rewritten.ok) expect(rewritten.value).toEqual(manifest);
    }
  });

  it('keeps the file´s own snake_case naming', () => {
    // These files are hand-written and diffed. A save that renamed `default_variants` would reset the
    // variant count to 1 on the next load.
    const written = serializeManifest(load('stable_audio_3.manifest.json'));
    expect('default_variants' in written).toBe(true);
    expect('defaultVariants' in written).toBe(false);
  });
});
