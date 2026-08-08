import { describe, expect, it } from 'vitest';
import type { DesktopBridge, FolderEntry } from '../main/ipc-contract.js';
import { GENERATORS_FOLDER, loadLibrary } from './use-generator-library.js';

/**
 * Reading the project's generator library.
 *
 * This is the spec's §5.6 startup path, and the property that matters is stated in its own doc comment:
 * one malformed manifest must not stop the other eight from loading. A registry that silently shrank
 * because a file had a trailing comma would be the worst possible failure — every generator that *did*
 * load looks fine, and the missing one looks like it was never installed.
 */

interface Files {
  readonly [path: string]: string;
}

function bridgeWith(
  files: Files,
  options: { unreadable?: readonly string[]; library?: Files } = {},
): DesktopBridge {
  const unreadable = new Set(options.unreadable ?? []);
  const library = options.library ?? {};

  return {
    async listLibrary(): Promise<readonly FolderEntry[]> {
      return Object.keys(library).map((name) => ({ path: name, name, kind: 'file' as const }));
    },
    async readLibraryFile(path: string): Promise<string | undefined> {
      return library[path];
    },
    async listFolder(path: string): Promise<readonly FolderEntry[]> {
      if (path !== GENERATORS_FOLDER) return [];
      return Object.keys(files).map((name) => ({
        path: `${GENERATORS_FOLDER}/${name}`,
        name,
        kind: 'file' as const,
      }));
    },
    async readTextFile(path: string): Promise<string | undefined> {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (unreadable.has(name)) return undefined;
      return files[name];
    },
  } as unknown as DesktopBridge;
}

const manifest = (id: string, graph = 'g.json'): string =>
  JSON.stringify({
    id,
    name: id,
    graph,
    produces: 'image',
    surfaces: ['media_browser'],
    outputs: [{ key: 'image', type: 'image', node: '9' }],
    params: [],
  });

describe('reading the folder', () => {
  it('parses every manifest', async () => {
    const result = await loadLibrary(
      bridgeWith({ 'a.manifest.json': manifest('a'), 'b.manifest.json': manifest('b') }),
    );
    expect(result.manifests.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('treats every other json as a graph', async () => {
    // The convention that lets a user drop a ComfyUI export straight in without renaming anything.
    const result = await loadLibrary(
      bridgeWith({ 'a.manifest.json': manifest('a', 'flow.json'), 'flow.json': '{"1":{}}' }),
    );
    expect([...result.graphs.keys()]).toEqual(['flow.json']);
  });

  it('ignores files that are not json at all', async () => {
    const result = await loadLibrary(bridgeWith({ 'notes.txt': 'hello', 'a.manifest.json': manifest('a') }));
    expect(result.manifests).toHaveLength(1);
    expect(result.problems).toEqual([]);
  });

  it('returns nothing for a project with no generators folder', async () => {
    const empty = { listFolder: async () => [] } as unknown as DesktopBridge;
    const result = await loadLibrary(empty);
    expect(result).toEqual({ manifests: [], graphs: new Map(), problems: [] });
  });
});

describe('one bad file does not take the others with it', () => {
  it('keeps loading past a syntax error', async () => {
    const result = await loadLibrary(
      bridgeWith({
        'broken.manifest.json': '{ "id": "broken", ',
        'good.manifest.json': manifest('good'),
      }),
    );

    expect(result.manifests.map((entry) => entry.id)).toEqual(['good']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.file).toBe('broken.manifest.json');
  });

  it('reports a manifest that parses but does not validate', async () => {
    // A file with no id is JSON but not a manifest. The registry never sees it, so the reason has to
    // come from here or it is lost.
    const result = await loadLibrary(
      bridgeWith({
        'nameless.manifest.json': '{"produces":"image"}',
        'good.manifest.json': manifest('good'),
      }),
    );

    expect(result.manifests).toHaveLength(1);
    expect(result.problems[0]?.detail).not.toBe('');
  });

  it('reports a file it could not read', async () => {
    const result = await loadLibrary(
      bridgeWith({ 'locked.manifest.json': manifest('locked') }, { unreadable: ['locked.manifest.json'] }),
    );

    expect(result.manifests).toHaveLength(0);
    expect(result.problems[0]?.detail).toContain('could not be read');
  });

  it('names the file in every problem, since that is what the user has to open', async () => {
    const result = await loadLibrary(bridgeWith({ 'one.manifest.json': '{', 'two.manifest.json': '{' }));
    expect(result.problems.map((problem) => problem.file).sort()).toEqual([
      'one.manifest.json',
      'two.manifest.json',
    ]);
  });

  it('names the offending field and what it expected, not just that something failed', async () => {
    // "bad.manifest.json is invalid" sends the user reading the whole file; naming the field and the
    // accepted values is the difference between a minute and an afternoon.
    const result = await loadLibrary(bridgeWith({ 'bad.manifest.json': '{"id":"x","produces":"nope"}' }));

    expect(result.problems[0]?.detail).toContain('produces');
    expect(result.problems[0]?.detail).toContain('image');
  });
});

describe('a graph that is not a graph', () => {
  it('still loads, because validity is the registry´s judgement rather than this one´s', async () => {
    // The registry reports an unresolvable pointer as a status with a reason. Rejecting the file here
    // would replace that specific message with a generic one.
    const result = await loadLibrary(bridgeWith({ 'flow.json': '[1,2,3]' }));
    expect(result.graphs.get('flow.json')).toEqual([1, 2, 3]);
    expect(result.problems).toEqual([]);
  });

  it('reports a graph that is not json', async () => {
    const result = await loadLibrary(bridgeWith({ 'flow.json': 'not json' }));
    expect(result.graphs.size).toBe(0);
    expect(result.problems[0]?.detail).toContain('not valid JSON');
  });
});

/**
 * The shared library.
 *
 * §5.6 asks for "the project's `generators/` folder **and the global library**", and only the first
 * was ever read — so every new project opened with no generators at all and the manifests had to be
 * copied into each one by hand.
 */
describe('the library beside the project', () => {
  const manifest = (id: string, name: string) =>
    JSON.stringify({
      id,
      name,
      backend: 'comfyui',
      graph: 'g.json',
      produces: 'audio',
      consumes: [],
      duration: 'declared',
      outputs: [{ key: 'a', type: 'audio', node: '1' }],
      params: [],
    });

  it('loads a generator the project does not have', async () => {
    const result = await loadLibrary(
      bridgeWith({}, { library: { 'shared.manifest.json': manifest('shared', 'Shared') } }),
    );
    expect(result.manifests.map((entry) => entry.id)).toEqual(['shared']);
  });

  it('loads both, so a project adds to the library rather than replacing it', async () => {
    const result = await loadLibrary(
      bridgeWith(
        { 'local.manifest.json': manifest('local', 'Local') },
        { library: { 'shared.manifest.json': manifest('shared', 'Shared') } },
      ),
    );
    expect(result.manifests.map((entry) => entry.id).sort()).toEqual(['local', 'shared']);
  });

  it('lets the project override an id the library already has', async () => {
    // A project shipping its own version of a generator means to use that one.
    const result = await loadLibrary(
      bridgeWith(
        { 'sfx.manifest.json': manifest('sfx', 'Project SFX') },
        { library: { 'sfx.manifest.json': manifest('sfx', 'Library SFX') } },
      ),
    );

    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]?.name).toBe('Project SFX');
  });

  it('says which one a bad file came from', async () => {
    // `sfx.manifest.json` in two places is otherwise one filename and two possible fixes.
    const result = await loadLibrary(bridgeWith({}, { library: { 'bad.manifest.json': '{"id":""}' } }));
    expect(result.problems[0]?.file).toBe('library/bad.manifest.json');
  });

  it('works with no library at all, which is a fresh install', async () => {
    const result = await loadLibrary(bridgeWith({ 'local.manifest.json': manifest('local', 'Local') }));
    expect(result.manifests.map((entry) => entry.id)).toEqual(['local']);
  });
});
