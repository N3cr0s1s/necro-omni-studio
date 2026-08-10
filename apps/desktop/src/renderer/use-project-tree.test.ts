import { describe, expect, it } from 'vitest';
import { buildTree } from '@nos/media';
import type { DesktopBridge } from '../main/ipc-contract.js';
import { walkProject } from './use-project-tree.js';

/**
 * What the browser is shown of the project folder.
 *
 * §4 defines a project *as* a folder structure and the browser as a view of the real tree. The walk
 * queued each folder for traversal and then dropped it, so the only directories the tree ever heard
 * about were the ones it could infer from the paths of files inside them — and an empty folder was
 * invisible. A new project showed `project.json` and nothing else: no `media/` to import into, no
 * `renders/`, no `notes/`.
 */

/** A bridge over a fixed folder layout. Only `listFolder` is reached. */
function bridgeOver(layout: Record<string, readonly { name: string; kind: 'file' | 'folder' }[]>) {
  return {
    listFolder: (path: string) =>
      Promise.resolve(
        (layout[path] ?? []).map((entry) => ({
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          name: entry.name,
          kind: entry.kind,
          ...(entry.kind === 'file' ? { sizeBytes: 10 } : {}),
        })),
      ),
  } as unknown as DesktopBridge;
}

const NEW_PROJECT = {
  '': [
    { name: 'project.json', kind: 'file' as const },
    { name: 'media', kind: 'folder' as const },
    { name: 'renders', kind: 'folder' as const },
  ],
  media: [],
  renders: [],
};

describe('walking the project folder', () => {
  it('reports an empty folder, which is most of a new project', async () => {
    const { entries } = await walkProject(bridgeOver(NEW_PROJECT));
    expect(entries.filter((entry) => entry.isDirectory).map((entry) => entry.path)).toEqual([
      'media',
      'renders',
    ]);
  });

  it('puts an empty folder in the tree the browser draws', async () => {
    // The end the user sees. `buildTree` has always had the branch for this and nothing could
    // reach it, so asserting on the walk alone would not say the two are joined up.
    const { entries } = await walkProject(bridgeOver(NEW_PROJECT));
    const names = buildTree(entries).children.map((child) => child.name);
    expect(names).toContain('media');
    expect(names).toContain('renders');
  });

  it('still reports the files, and their folders once', async () => {
    const { entries } = await walkProject(
      bridgeOver({
        '': [{ name: 'media', kind: 'folder' as const }],
        media: [{ name: 'a.mp4', kind: 'file' as const }],
      }),
    );
    expect(entries.map((entry) => entry.path)).toEqual(['media', 'media/a.mp4']);
  });

  it('counts a folder against the entry ceiling, since a deep tree is mostly folders', async () => {
    const { entries, truncated } = await walkProject(
      bridgeOver({
        '': [
          { name: 'a', kind: 'folder' as const },
          { name: 'b', kind: 'folder' as const },
          { name: 'c', kind: 'folder' as const },
        ],
        a: [],
        b: [],
        c: [],
      }),
      2,
    );
    expect(truncated).toBe(true);
    expect(entries).toHaveLength(2);
  });
});
