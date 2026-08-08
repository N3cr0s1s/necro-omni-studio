import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PROJECT_SUBFOLDERS,
  ProjectPathError,
  ensureLayout,
  readProjectFile,
  resolveInProject,
  toProjectRelative,
  writeProjectFile,
} from './project-folder.js';

/**
 * Every temporary root this file made, removed when it is done.
 *
 * Tracked rather than cleaned up per test, because several tests deliberately leave a folder in a
 * particular state and read it back. Without this the suite leaked one directory per call — a full
 * checkout's worth of runs had left 1288 of them under `/tmp`, which is the sort of thing nobody
 * notices until a disk fills.
 */
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nos-project-'));
  roots.push(root);
  return root;
}

describe('containment', () => {
  it('resolves an ordinary project-relative path', () => {
    expect(resolveInProject('/p', 'media/a.mp4')).toBe(join('/p', 'media', 'a.mp4'));
  });

  it('refuses to climb out with ..', () => {
    for (const attempt of ['../secrets', 'media/../../secrets', '..']) {
      expect(() => resolveInProject('/p', attempt), attempt).toThrow(ProjectPathError);
    }
  });

  it('refuses an absolute path', () => {
    // The renderer only ever names project-relative paths; an absolute one reaching here means either a
    // bug or an attempt.
    expect(() => resolveInProject('/p', '/etc/passwd')).toThrow(ProjectPathError);
  });

  it('refuses the root itself, which is not a file', () => {
    expect(() => resolveInProject('/p', '.')).toThrow(ProjectPathError);
  });

  it('does not fall for a sibling with the same prefix', () => {
    // The bug a `startsWith` check has: `/project-backup` begins with `/project`.
    expect(() => resolveInProject('/p', '../p-backup/secret')).toThrow(ProjectPathError);
  });

  it('names what was refused, so the failure is diagnosable', () => {
    try {
      resolveInProject('/p', '../x');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as ProjectPathError).requested).toBe('../x');
    }
  });
});

describe('project-relative paths', () => {
  it('uses forward slashes on every platform', () => {
    // Asset identity is a project-relative path. A project authored on Windows must open on Linux with
    // the same identities, or every clip loses its media.
    const absolute = ['media', 'shoot', 'a.mp4'].join(sep);
    expect(toProjectRelative('/p', join('/p', absolute))).toBe('media/shoot/a.mp4');
  });

  it('reports a path outside the project as outside, rather than guessing', () => {
    expect(toProjectRelative('/p', '/elsewhere/a.mp4')).toBeUndefined();
    expect(toProjectRelative('/p', '/p')).toBeUndefined();
  });
});

describe('the folder layout', () => {
  it('creates every folder the spec defines', async () => {
    const root = await temporaryRoot();
    await ensureLayout(root);

    const created = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(created).toEqual([...PROJECT_SUBFOLDERS].sort());
  });

  it('is idempotent, so opening an existing project is harmless', async () => {
    const root = await temporaryRoot();
    await ensureLayout(root);
    await writeFile(join(root, 'media', 'keep.txt'), 'kept', 'utf8');
    await ensureLayout(root);

    expect(await readFile(join(root, 'media', 'keep.txt'), 'utf8')).toBe('kept');
  });
});

describe('the project file', () => {
  it('round trips', async () => {
    const root = await temporaryRoot();
    await ensureLayout(root);
    await writeProjectFile(root, '{"schemaVersion":1}');

    expect(await readProjectFile(root)).toBe('{"schemaVersion":1}');
  });

  it('treats a folder with no project file as a new project, not an error', async () => {
    const root = await temporaryRoot();
    await ensureLayout(root);
    expect(await readProjectFile(root)).toBeUndefined();
  });

  it('leaves no temporary file behind', async () => {
    // The write goes through a temp file and a rename; a leftover `.partial` would show up in the media
    // browser as project content.
    const root = await temporaryRoot();
    await ensureLayout(root);
    await writeProjectFile(root, '{}');

    const names = (await readdir(root)).filter((name) => name.includes('partial'));
    expect(names).toEqual([]);
  });

  it('replaces the previous contents completely', async () => {
    const root = await temporaryRoot();
    await ensureLayout(root);
    await writeProjectFile(root, '{"a":"a very long previous document"}');
    await writeProjectFile(root, '{"b":1}');

    expect(await readProjectFile(root)).toBe('{"b":1}');
  });
});

describe('symlinks', () => {
  it('reports a link pointing outside the project as outside', async () => {
    // The case a string check misses entirely: nothing about `media/escape` looks suspicious, and it
    // resolves to somewhere else on the disk.
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await ensureLayout(root);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(outside, join(root, 'media', 'escape'));

    const { realpath } = await import('node:fs/promises');
    const resolved = await realpath(join(root, 'media', 'escape', 'secret.txt'));

    expect(toProjectRelative(root, resolved)).toBeUndefined();
  });
});
