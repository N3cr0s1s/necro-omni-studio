import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileChange, WatcherError } from '@nos/media';
import { describeStartFailure, toRelative, watchProject } from './project-watcher.js';

/**
 * Watching a real folder.
 *
 * Against the real filesystem, not a mock: the whole difficulty of this module is that `fs.watch`
 * reports that *something* happened without saying what, and a fake that answered questions
 * truthfully would test nothing. What is asserted is the translation — a written file becomes an
 * `added` with its final size, a deleted one becomes `removed`, a burst becomes one batch.
 */

const roots: string[] = [];
const handles: { close(): void }[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nos-watch-'));
  roots.push(root);
  await mkdir(join(root, 'media'), { recursive: true });
  return root;
}

/** Collects batches until one satisfies `until`, or the wait runs out. */
function watching(root: string): {
  readonly batches: (readonly FileChange[])[];
  readonly errors: WatcherError[];
  waitFor(predicate: (all: readonly FileChange[]) => boolean, ms?: number): Promise<readonly FileChange[]>;
} {
  const batches: (readonly FileChange[])[] = [];
  const errors: WatcherError[] = [];

  handles.push(
    watchProject(root, {
      onChanges: (changes) => batches.push(changes),
      onError: (error) => errors.push(error),
    }),
  );

  return {
    batches,
    errors,
    async waitFor(predicate, ms = 4000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const all = batches.flat();
        if (predicate(all)) return all;
        if (Date.now() > deadline) return all;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

describe('translating filesystem events', () => {
  it('reports a new file with the path the project uses', async () => {
    const root = await project();
    const observer = watching(root);

    await writeFile(join(root, 'media', 'clip.mp4'), 'x');
    const changes = await observer.waitFor((all) => all.some((c) => c.path === 'media/clip.mp4'));

    const change = changes.find((c) => c.path === 'media/clip.mp4');
    expect(change?.kind).toBe('added');
    expect(change?.isDirectory).toBe(false);
  });

  it('reports the size the file settled at, not the size mid-write', async () => {
    // The reason the settle window exists: a large generator output is written in chunks, and a size
    // read at the first event would describe a file that no longer exists in that form.
    const root = await project();
    const observer = watching(root);

    const target = join(root, 'media', 'big.bin');
    await writeFile(target, 'a'.repeat(10));
    await writeFile(target, 'a'.repeat(5000));

    const changes = await observer.waitFor((all) => all.some((c) => c.path === 'media/big.bin'));
    expect(changes.find((c) => c.path === 'media/big.bin')?.sizeBytes).toBe(5000);
  });

  it('reports a deletion as removed', async () => {
    const root = await project();
    const target = join(root, 'media', 'gone.mp4');
    await writeFile(target, 'x');
    const observer = watching(root);

    await rm(target);
    const changes = await observer.waitFor((all) =>
      all.some((c) => c.path === 'media/gone.mp4' && c.kind === 'removed'),
    );

    expect(changes.find((c) => c.path === 'media/gone.mp4')?.kind).toBe('removed');
  });

  it('sees a new folder as a folder', async () => {
    const root = await project();
    const observer = watching(root);

    await mkdir(join(root, 'media', 'shoot-2'));
    const changes = await observer.waitFor((all) => all.some((c) => c.path === 'media/shoot-2'));

    expect(changes.find((c) => c.path === 'media/shoot-2')?.isDirectory).toBe(true);
  });

  it('watches into subdirectories, which is where generated output lands', async () => {
    const root = await project();
    await mkdir(join(root, 'generated', 'run-1'), { recursive: true });
    const observer = watching(root);

    await writeFile(join(root, 'generated', 'run-1', 'seed4471.mp4'), 'x');
    const changes = await observer.waitFor((all) =>
      all.some((c) => c.path === 'generated/run-1/seed4471.mp4'),
    );

    expect(changes.some((c) => c.path === 'generated/run-1/seed4471.mp4')).toBe(true);
  });

  it('finds files written into a folder created moments earlier', async () => {
    // The case a generator produces: create an output folder, immediately fill it. The recursive
    // watcher registers interest in a new subdirectory only once it has seen it, so files written in
    // that window arrive with no event of their own and would never appear in the browser.
    const root = await project();
    const observer = watching(root);

    await mkdir(join(root, 'generated', 'run-9'), { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(root, 'generated', 'run-9', `v${index}.mp4`), 'x');
    }

    const changes = await observer.waitFor((all) =>
      [0, 1, 2, 3, 4].every((index) => all.some((c) => c.path === `generated/run-9/v${index}.mp4`)),
    );

    for (let index = 0; index < 5; index += 1) {
      expect(changes.some((c) => c.path === `generated/run-9/v${index}.mp4`)).toBe(true);
    }
  });

  it('does not walk a folder that was removed again', async () => {
    const root = await project();
    const observer = watching(root);

    await mkdir(join(root, 'media', 'transient'));
    await rm(join(root, 'media', 'transient'), { recursive: true });
    await observer.waitFor((all) => all.some((c) => c.path === 'media/transient'));

    expect(observer.errors).toEqual([]);
  });

  it('collapses a burst into one batch', async () => {
    // A generator writing a variant set, or an unzip. One batch per file would re-render the tree
    // dozens of times and blow the 16 ms budget for the duration of the burst.
    const root = await project();
    const observer = watching(root);

    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(root, 'media', `v${index}.mp4`), 'x');
    }
    await observer.waitFor((all) => all.length >= 20);

    expect(observer.batches.length).toBeLessThanOrEqual(3);
  });

  it('asks the filesystem once per path, however many events it fired', async () => {
    const root = await project();
    const observer = watching(root);

    const target = join(root, 'media', 'saved.mp4');
    for (let index = 0; index < 5; index += 1) await writeFile(target, `x${index}`);
    const changes = await observer.waitFor((all) => all.some((c) => c.path === 'media/saved.mp4'));

    expect(changes.filter((c) => c.path === 'media/saved.mp4')).toHaveLength(1);
  });

  it('stops reporting once closed', async () => {
    const root = await project();
    const observer = watching(root);
    handles.splice(0).forEach((handle) => handle.close());

    await writeFile(join(root, 'media', 'after.mp4'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(observer.batches.flat()).toEqual([]);
  });
});

describe('a watcher that cannot start', () => {
  it('reports rather than throws, so the browser can offer a rescan', () => {
    // A "watching" indicator over a tree that has stopped tracking reality is the outcome worth
    // avoiding; an honest "not watching" with a refresh button is not.
    const errors: WatcherError[] = [];
    const handle = watchProject(join(tmpdir(), 'nos-does-not-exist-4471'), {
      onChanges: () => undefined,
      onError: (error) => errors.push(error),
    });
    handle.close();

    expect(errors[0]?.kind).toBe('root-missing');
  });

  it('names the inotify limit, whose real cause is unguessable from the raw message', () => {
    expect(describeStartFailure(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })).kind).toBe(
      'limit-exceeded',
    );
  });

  it('distinguishes a permission failure from a generic one', () => {
    expect(describeStartFailure(Object.assign(new Error('x'), { code: 'EACCES' })).kind).toBe(
      'permission-denied',
    );
    expect(describeStartFailure(new Error('x')).kind).toBe('failed');
  });
});

describe('path normalization', () => {
  it('ignores an event with no filename, which some platforms send', () => {
    expect(toRelative(null)).toBeUndefined();
    expect(toRelative('')).toBeUndefined();
  });

  it('accepts a buffer, which is what a non-UTF-8 name arrives as', () => {
    expect(toRelative(Buffer.from('media/a.mp4'))).toBe('media/a.mp4');
  });
});
