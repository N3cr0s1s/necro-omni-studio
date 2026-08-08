import { describe, expect, it } from 'vitest';
import type { DesktopBridge, FolderEntry } from '../main/ipc-contract.js';
import { loadEffects } from './use-effect-library.js';

/**
 * Reading the project's own effects.
 *
 * §4 reserves `effects/` for project-local shaders and manifests and §6.3 defines an effect as a
 * shader plus a manifest — so the effect system was designed to be extended by dropping two files into
 * a folder. The folder was created by the scaffolder and nothing ever read it.
 *
 * What is worth pinning down is every way the two files can disagree, because a user editing them by
 * hand will find all of them: a manifest that is not JSON, one naming a shader that is not there, and
 * one file being broken while the others are fine.
 */

type Files = Readonly<Record<string, string>>;

function bridgeWith(files: Files): DesktopBridge {
  const entries: FolderEntry[] = Object.keys(files).map((path) => ({
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    kind: 'file' as const,
    sizeBytes: files[path]?.length ?? 0,
  }));

  return {
    listFolder: async (folder: string) => entries.filter((entry) => entry.path.startsWith(`${folder}/`)),
    readTextFile: async (path: string) => files[path],
  } as unknown as DesktopBridge;
}

const manifest = (id: string, shader: string) =>
  JSON.stringify({ id, name: id, category: 'effect', shader, samplers: ['source'], params: [] });

describe('reading the folder', () => {
  it('reads a manifest and the shader beside it', async () => {
    const result = await loadEffects(
      bridgeWith({
        'effects/vignette.json': manifest('vignette', 'vignette.frag'),
        'effects/vignette.frag': 'void main() {}',
      }),
    );

    expect(result.local).toHaveLength(1);
    expect(result.local[0]?.shaderSource).toBe('void main() {}');
    expect(result.local[0]?.origin).toBe('effects/vignette.json');
    expect(result.problems).toEqual([]);
  });

  it('is empty for a project with no effects of its own', async () => {
    expect((await loadEffects(bridgeWith({}))).local).toEqual([]);
  });

  it('ignores a file that is not a manifest', async () => {
    // A stray shader with no manifest is not an effect; it is half of one.
    const result = await loadEffects(bridgeWith({ 'effects/orphan.frag': 'void main() {}' }));
    expect(result.local).toEqual([]);
    expect(result.problems).toEqual([]);
  });
});

describe('when the two files disagree', () => {
  it('passes a manifest whose shader is missing, with no source', async () => {
    // Reported by the *registry* rather than here, because "the shader is not there" and "the manifest
    // is wrong" have different fixes and the message has to say which.
    const result = await loadEffects(bridgeWith({ 'effects/v.json': manifest('v', 'gone.frag') }));

    expect(result.local).toHaveLength(1);
    expect(result.local[0]?.shaderSource).toBeUndefined();
    expect(result.problems).toEqual([]);
  });

  it('reports a file that is not JSON, and keeps going', async () => {
    const result = await loadEffects(
      bridgeWith({
        'effects/broken.json': '{ not json',
        'effects/good.json': manifest('good', 'good.frag'),
        'effects/good.frag': 'void main() {}',
      }),
    );

    expect(result.problems.map((problem) => problem.file)).toEqual(['broken.json']);
    // The whole point of collecting rather than throwing: one bad file must not take the others.
    expect(result.local.map((entry) => entry.origin)).toEqual(['effects/good.json']);
  });

  it('reports a file it could not read at all', async () => {
    const api = bridgeWith({ 'effects/v.json': manifest('v', 'v.frag') });
    const unreadable = { ...api, readTextFile: async () => undefined } as unknown as DesktopBridge;

    const result = await loadEffects(unreadable);
    expect(result.problems[0]).toEqual({ file: 'v.json', detail: 'could not be read' });
  });

  it('does not go looking for a shader a manifest never names', async () => {
    const result = await loadEffects(bridgeWith({ 'effects/v.json': JSON.stringify({ id: 'v' }) }));
    expect(result.local[0]?.shaderSource).toBeUndefined();
    expect(result.problems).toEqual([]);
  });
});
