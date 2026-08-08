import { describe, expect, it } from 'vitest';
import { assetPath } from '@nos/core';
import { buildTree } from '@nos/media';
import { assetChoicesFrom } from './generator-assets.js';

function tree(paths: readonly string[]) {
  return buildTree(paths.map((path) => ({ path: assetPath(path), sizeBytes: 1, isDirectory: false })));
}

describe('offering a project’s files to a generator', () => {
  it('is empty before a project is open', () => {
    expect(assetChoicesFrom(undefined)).toEqual([]);
  });

  it('offers each file with its type, so a parameter can filter by it', () => {
    const choices = assetChoicesFrom(tree(['media/frame.png', 'media/take.mp4']));
    expect(choices).toEqual([
      { path: 'media/frame.png', label: 'frame.png', type: 'image' },
      { path: 'media/take.mp4', label: 'take.mp4', type: 'video' },
    ]);
  });

  it('leaves out files it cannot type', () => {
    expect(assetChoicesFrom(tree(['media/notes.bin'])).map((choice) => choice.label)).toEqual([]);
  });

  it('never offers a cached derivative', () => {
    // A run pinned to one would stop reproducing the moment the cache was cleared, and the file is
    // regenerated under a different name.
    const choices = assetChoicesFrom(tree(['media/a.png', 'cache/thumbs/a.png']));
    expect(choices.map((choice) => choice.path)).toEqual(['media/a.png']);
  });

  it('names a file by its path once the bare name is ambiguous', () => {
    // Two rows reading `frame.png` look like a working list right up until the wrong one is chosen.
    const choices = assetChoicesFrom(tree(['media/frame.png', 'generated/frame.png', 'media/only.png']));
    expect(choices.map((choice) => choice.label)).toEqual([
      'generated/frame.png',
      'media/frame.png',
      'only.png',
    ]);
  });

  it('sorts naturally, so take2 comes before take10', () => {
    const choices = assetChoicesFrom(tree(['media/take10.png', 'media/take2.png']));
    expect(choices.map((choice) => choice.label)).toEqual(['take2.png', 'take10.png']);
  });
});
