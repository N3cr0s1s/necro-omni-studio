import { describe, expect, it } from 'vitest';
import { assetPath } from '@nos/core';
import {
  type DirectoryNode,
  type FileEntry,
  allFiles,
  applyChanges,
  buildTree,
  filesOfType,
  findNode,
  formatBytes,
  walkTree,
} from './folder-tree.js';
import type { FileChange } from '../contracts/watcher.js';

function file(path: string, sizeBytes = 100, modifiedAt?: number): FileEntry {
  return {
    path: assetPath(path),
    sizeBytes,
    isDirectory: false,
    ...(modifiedAt !== undefined ? { modifiedAt } : {}),
  };
}

function directory(path: string): FileEntry {
  return { path: assetPath(path), sizeBytes: 0, isDirectory: true };
}

/** The folder layout from the mockups. */
function projectEntries(): readonly FileEntry[] {
  return [
    file('project.json', 4_096),
    file('media/interview_a.mp4', 1_000_000),
    file('media/interview_b.mp4', 900_000),
    file('media/broll_city.mov', 500_000),
    file('media/room_tone.wav', 20_000),
    file('generated/t2v_0117_seed4471.mp4', 2_000_000),
    file('generated/bed_0031_seed881.flac', 300_000),
    file('generated/bed_0031_seed882.flac', 300_000),
    file('notes/treatment.md', 2_000),
    file('notes/vo_script.md', 3_000),
    directory('renders'),
    directory('cache'),
    file('cache/proxy_1080p30q23_abc0123456789def.mp4', 50_000_000),
  ];
}

describe('buildTree', () => {
  it('synthesizes directories from file paths alone', () => {
    const tree = buildTree([file('media/sub/deep/a.mp4')]);
    const media = tree.children[0]!;
    expect(media.kind).toBe('directory');
    expect(media.name).toBe('media');
    expect(findNode(tree, 'media/sub/deep')?.kind).toBe('directory');
    expect(findNode(tree, 'media/sub/deep/a.mp4')?.kind).toBe('file');
  });

  it('keeps empty directories, since an empty renders/ is meaningful', () => {
    const tree = buildTree([directory('renders')]);
    expect(findNode(tree, 'renders')?.kind).toBe('directory');
  });

  it('classifies files by extension', () => {
    const tree = buildTree(projectEntries());
    const node = findNode(tree, 'media/interview_a.mp4');
    expect(node?.kind === 'file' && node.assetType).toBe('video');
    const note = findNode(tree, 'notes/treatment.md');
    expect(note?.kind === 'file' && note.assetType).toBe('text');
  });

  it('excludes cache contents but keeps the cache directory', () => {
    const tree = buildTree(projectEntries());
    const cache = findNode(tree, 'cache');
    expect(cache?.kind).toBe('directory');
    expect(cache?.kind === 'directory' && cache.children).toEqual([]);
    expect(findNode(tree, 'cache/proxy_1080p30q23_abc0123456789def.mp4')).toBeUndefined();
  });

  it('excludes ignored files', () => {
    const tree = buildTree([file('media/.DS_Store'), file('media/a.mp4')]);
    expect(allFiles(tree).map((entry) => entry.path)).toEqual(['media/a.mp4']);
  });
});

describe('sizes and counts', () => {
  it('rolls size up recursively, which is what the generated/ readout shows', () => {
    const tree = buildTree(projectEntries());
    const generated = findNode(tree, 'generated');
    expect(generated?.kind === 'directory' && generated.sizeBytes).toBe(2_600_000);
  });

  it('counts files transitively', () => {
    const tree = buildTree([file('a/b/one.mp4'), file('a/b/two.mp4'), file('a/three.mp4')]);
    const a = findNode(tree, 'a');
    expect(a?.kind === 'directory' && a.fileCount).toBe(3);
  });

  it('excludes cache contents from the parent size roll-up', () => {
    // The cache is shown with its own size, but must not inflate the project total.
    const tree = buildTree(projectEntries());
    const cache = findNode(tree, 'cache');
    expect(cache?.kind === 'directory' && cache.sizeBytes).toBe(0);
  });

  it('reports zero for an empty directory', () => {
    const tree = buildTree([directory('renders')]);
    const renders = findNode(tree, 'renders');
    expect(renders?.kind === 'directory' && renders.fileCount).toBe(0);
  });
});

describe('ordering', () => {
  it('puts directories before files', () => {
    const tree = buildTree([file('zzz.md'), file('media/a.mp4')]);
    expect(tree.children.map((node) => node.kind)).toEqual(['directory', 'file']);
  });

  it('pins project.json above the folders, since it is the project', () => {
    // The one exception to directories-first, and what the mockups show.
    const tree = buildTree(projectEntries());
    expect(tree.children[0]?.name).toBe('project.json');
    expect(tree.children[1]?.name).toBe('media');
  });

  it('does not pin a project.json nested in a subfolder', () => {
    const tree = buildTree([file('notes/project.json'), file('notes/a.md'), directory('notes/sub')]);
    const notes = findNode(tree, 'notes');
    // Inside `notes/` it is just a file, so the general rule applies and the directory wins.
    expect(notes?.kind === 'directory' && notes.children[0]?.name).toBe('sub');
  });

  it('pins reserved project folders in their conventional order', () => {
    // The browser is navigated by muscle memory: `media` must not sort below `archive`.
    const tree = buildTree([
      directory('renders'),
      directory('cache'),
      directory('media'),
      directory('generated'),
      directory('notes'),
      directory('archive'),
    ]);
    expect(tree.children.map((node) => node.name)).toEqual([
      'media',
      'generated',
      'notes',
      'renders',
      'cache',
      'archive',
    ]);
  });

  it('sorts files case-insensitively and numerically', () => {
    const tree = buildTree([file('media/b_10.mp4'), file('media/B_2.mp4'), file('media/a.mp4')]);
    const media = findNode(tree, 'media');
    expect(media?.kind === 'directory' && media.children.map((node) => node.name)).toEqual([
      'a.mp4',
      'B_2.mp4',
      'b_10.mp4',
    ]);
  });
});

describe('applyChanges', () => {
  it('prunes a removed folder even when the watcher could not say it was one', () => {
    // The case a real watcher produces: a path vanishes, and there is nothing left to ask what it
    // was. Requiring `isDirectory` here would leave the contents of every deleted folder in the tree.
    const entries = applyChanges(
      [file('generated/run-9/v0.mp4'), file('generated/run-9/v1.mp4'), file('media/keep.mp4')],
      [{ kind: 'removed', path: assetPath('generated/run-9'), isDirectory: false }],
    );

    expect(entries.map((entry) => entry.path)).toEqual(['media/keep.mp4']);
  });

  it('does not prune a sibling whose name merely starts the same way', () => {
    const entries = applyChanges(
      [file('media/take.mp4'), file('media/take-2.mp4')],
      [{ kind: 'removed', path: assetPath('media/take'), isDirectory: false }],
    );

    expect(entries.map((entry) => entry.path)).toEqual(['media/take.mp4', 'media/take-2.mp4']);
  });

  it('adds a new entry', () => {
    const entries = applyChanges(
      [],
      [{ kind: 'added', path: assetPath('media/a.mp4'), isDirectory: false, sizeBytes: 10 }],
    );
    expect(entries).toEqual([{ path: 'media/a.mp4', isDirectory: false, sizeBytes: 10 }]);
  });

  it('updates size on change', () => {
    const before = [file('media/a.mp4', 10)];
    const after = applyChanges(before, [
      { kind: 'changed', path: assetPath('media/a.mp4'), isDirectory: false, sizeBytes: 20 },
    ]);
    expect(after[0]!.sizeBytes).toBe(20);
  });

  it('keeps the previous size when a change omits it', () => {
    const before = [file('media/a.mp4', 10, 500)];
    const after = applyChanges(before, [
      { kind: 'changed', path: assetPath('media/a.mp4'), isDirectory: false },
    ]);
    expect(after[0]!.sizeBytes).toBe(10);
    expect(after[0]!.modifiedAt).toBe(500);
  });

  it('removes an entry', () => {
    const after = applyChanges(
      [file('media/a.mp4'), file('media/b.mp4')],
      [{ kind: 'removed', path: assetPath('media/a.mp4'), isDirectory: false }],
    );
    expect(after.map((entry) => entry.path)).toEqual(['media/b.mp4']);
  });

  it('removes a directory subtree, which watchers do not always report per child', () => {
    const after = applyChanges(
      [file('media/sub/a.mp4'), file('media/sub/b.mp4'), file('media/keep.mp4')],
      [{ kind: 'removed', path: assetPath('media/sub'), isDirectory: true }],
    );
    expect(after.map((entry) => entry.path)).toEqual(['media/keep.mp4']);
  });

  it('does not remove a sibling with a shared name prefix', () => {
    const after = applyChanges(
      [file('media/sub/a.mp4'), file('media/subtitles/b.srt')],
      [{ kind: 'removed', path: assetPath('media/sub'), isDirectory: true }],
    );
    expect(after.map((entry) => entry.path)).toEqual(['media/subtitles/b.srt']);
  });

  it('composes with buildTree to reflect a generator writing output', () => {
    let entries = projectEntries();
    const batch: readonly FileChange[] = [
      {
        kind: 'added',
        path: assetPath('generated/bed_0031_seed883.flac'),
        isDirectory: false,
        sizeBytes: 300_000,
      },
    ];
    entries = applyChanges(entries, batch);
    const tree = buildTree(entries);
    const generated = findNode(tree, 'generated');
    expect(generated?.kind === 'directory' && generated.fileCount).toBe(4);
    expect(generated?.kind === 'directory' && generated.sizeBytes).toBe(2_900_000);
  });
});

describe('queries', () => {
  it('walks depth-first in display order', () => {
    const tree = buildTree([file('media/a.mp4'), file('notes/b.md')]);
    expect([...walkTree(tree)].map((node) => node.path)).toEqual([
      'media',
      'media/a.mp4',
      'notes',
      'notes/b.md',
    ]);
  });

  it('finds the root for an empty path', () => {
    const tree = buildTree(projectEntries());
    expect(findNode(tree, '')).toBe(tree as DirectoryNode);
  });

  it('returns undefined for a missing path', () => {
    expect(findNode(buildTree([]), 'nope')).toBeUndefined();
  });

  it('filters files by asset type, preserving display order', () => {
    // Display order, not alphabetical: `media/` is pinned above `generated/`, so
    // room_tone comes first even though its name sorts last.
    const tree = buildTree(projectEntries());
    expect(filesOfType(tree, 'audio').map((entry) => entry.name)).toEqual([
      'room_tone.wav',
      'bed_0031_seed881.flac',
      'bed_0031_seed882.flac',
    ]);
  });
});

describe('formatBytes', () => {
  it('matches the mockups formatting', () => {
    expect(formatBytes(2_588_490_240)).toBe('2.41 GB');
  });

  it('uses bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('steps units and drops precision as magnitude grows', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 20)).toBe('20.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
  });

  it('stops at terabytes rather than inventing a unit', () => {
    expect(formatBytes(1024 ** 5)).toContain('TB');
  });
});
