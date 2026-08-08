import { describe, expect, it } from 'vitest';
import { assetPath } from '@nos/core';
import { type FileEntry, buildTree } from './folder-tree.js';
import { filterTree, isNarrowing } from './filter-tree.js';

/**
 * Finding a file in a project folder.
 *
 * The case this exists for is real and specific: `generated/` fills with names like
 * `d318c0ca-…_stable_audio_3_00090.flac`, forty of them differ only in the middle, and scrolling is
 * not a way to find one.
 */

function file(path: string, sizeBytes = 100): FileEntry {
  return { path: assetPath(path), sizeBytes, isDirectory: false };
}

/** A folder shaped like a project that has been generating for a while. */
function project() {
  return buildTree([
    file('media/interview.mp4', 1000),
    file('media/room-tone.flac', 200),
    file('generated/aaa_stable_audio_3_00090.flac', 300),
    file('generated/bbb_stable_audio_3_00091.flac', 400),
    file('generated/ccc_krea2_turbo_00140.png', 500),
    file('renders/cut.mp4', 900),
  ]);
}

const names = (node: ReturnType<typeof project>): readonly string[] => {
  const out: string[] = [];
  const walk = (current: (typeof node)['children'][number]): void => {
    if (current.kind === 'file') out.push(current.name);
    else for (const child of current.children) walk(child);
  };
  for (const child of node.children) walk(child);
  return out;
};

describe('whether a filter narrows anything', () => {
  it('is false for nothing asked for', () => {
    expect(isNarrowing({})).toBe(false);
    expect(isNarrowing({ query: '   ' })).toBe(false);
  });

  it('is true once there is a query or a type', () => {
    expect(isNarrowing({ query: 'clang' })).toBe(true);
    expect(isNarrowing({ assetType: 'audio' })).toBe(true);
  });
});

describe('filtering by name', () => {
  it('returns the tree untouched when nothing is asked for', () => {
    const tree = project();
    expect(filterTree(tree, {})).toBe(tree);
  });

  it('finds every take of one generator', () => {
    // Half of how these names are read: which generator made it.
    expect(names(filterTree(project(), { query: 'stable_audio' }))).toEqual([
      'aaa_stable_audio_3_00090.flac',
      'bbb_stable_audio_3_00091.flac',
    ]);
  });

  it('finds one file by the counter that distinguishes it', () => {
    // The other half: which take. The part that differs sits in the middle of the name, which is why
    // matching is a substring and not a prefix.
    expect(names(filterTree(project(), { query: '00091' }))).toEqual(['bbb_stable_audio_3_00091.flac']);
  });

  it('ignores case, because nobody types a uuid in the right case', () => {
    expect(names(filterTree(project(), { query: 'STABLE_Audio' }))).toHaveLength(2);
  });

  it('keeps the folder a match lives in, so a result is still shown where it is', () => {
    const filtered = filterTree(project(), { query: '00091' });
    expect(filtered.children.map((child) => child.name)).toEqual(['generated']);
  });

  it('keeps a folder whole when the folder itself is what was named', () => {
    // Typing `generated` asks for that folder, not for an empty one.
    expect(names(filterTree(project(), { query: 'generated' }))).toHaveLength(3);
  });

  it('is an empty root when nothing matches, not nothing at all', () => {
    // The browser needs somewhere to say so; a caller handed `undefined` would invent a root.
    const filtered = filterTree(project(), { query: 'nothing here' });
    expect(filtered.kind).toBe('directory');
    expect(filtered.children).toEqual([]);
  });
});

describe('filtering by kind', () => {
  it('keeps only that kind', () => {
    expect(names(filterTree(project(), { assetType: 'audio' }))).toEqual([
      'room-tone.flac',
      'aaa_stable_audio_3_00090.flac',
      'bbb_stable_audio_3_00091.flac',
    ]);
  });

  it('combines with a query rather than replacing it', () => {
    expect(names(filterTree(project(), { query: 'stable', assetType: 'audio' }))).toHaveLength(2);
    expect(names(filterTree(project(), { query: 'stable', assetType: 'image' }))).toEqual([]);
  });

  it('does not keep a folder whole just because its name matched', () => {
    // With a kind asked for, `generated` must not smuggle the png back in.
    expect(names(filterTree(project(), { query: 'generated', assetType: 'audio' }))).toEqual([
      'aaa_stable_audio_3_00090.flac',
      'bbb_stable_audio_3_00091.flac',
    ]);
  });
});

describe('the numbers a folder carries', () => {
  it('counts what survived, not what was there', () => {
    // `generated/` reading 47.9 MB above the one file that matched is a number contradicting the
    // screen, which is worse than no number.
    const filtered = filterTree(project(), { query: '00090' });
    const generated = filtered.children[0];

    expect(generated?.kind).toBe('directory');
    if (generated?.kind === 'directory') {
      expect(generated.fileCount).toBe(1);
      expect(generated.sizeBytes).toBe(300);
    }
  });

  it('adds them up through the levels it kept', () => {
    const filtered = filterTree(project(), { assetType: 'audio' });
    expect(filtered.fileCount).toBe(3);
    expect(filtered.sizeBytes).toBe(200 + 300 + 400);
  });
});
