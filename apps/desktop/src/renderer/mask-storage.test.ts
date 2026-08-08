import { describe, expect, it, vi } from 'vitest';
import { assetPath } from '@nos/core';
import { createBridgeMaskStorage } from './mask-storage.js';
import type { DesktopBridge, FolderEntry } from '../main/ipc-contract.js';

/**
 * The mask cache's storage, on the project folder.
 *
 * `@nos/masks` has had a content-addressed cache since M11 and was never given a real place to put
 * anything, so masks lived in React state alone: closing the application lost them, and a project
 * reopened the next morning had an effect bound to a mask that existed nowhere — which renders
 * *unmasked*, and reads as the mask being wrong rather than as the mask being gone.
 */

function fakeBridge(overrides: Partial<DesktopBridge> = {}) {
  const readTextFile = vi.fn(async () => undefined as string | undefined);
  const writeTextFile = vi.fn(async () => undefined);
  const listFolder = vi.fn(async () => [] as readonly FolderEntry[]);
  const trashEntry = vi.fn(async () => ({ ok: true }));
  const api = {
    readTextFile,
    writeTextFile,
    listFolder,
    trashEntry,
    ...overrides,
  } as unknown as DesktopBridge;
  return { api, readTextFile, writeTextFile, listFolder, trashEntry };
}

const entry = (path: string, kind: 'file' | 'folder'): FolderEntry => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind,
});

describe('listing a cache folder', () => {
  it('returns the entries´ own paths rather than rebuilding them', async () => {
    // The bridge already produces project-relative paths with forward slashes on every platform.
    // Reassembling one here would be a second definition of what a path is, and they would differ on
    // Windows first.
    const { api, listFolder } = fakeBridge();
    listFolder.mockResolvedValue([entry('masks/abc/0.rle', 'file'), entry('masks/abc/1.rle', 'file')]);

    const storage = createBridgeMaskStorage(() => api);
    expect(await storage.list(assetPath('masks/abc'))).toEqual(['masks/abc/0.rle', 'masks/abc/1.rle']);
  });

  it('ignores folders, which are not frames', async () => {
    const { api, listFolder } = fakeBridge();
    listFolder.mockResolvedValue([entry('masks/abc/nested', 'folder'), entry('masks/abc/0.rle', 'file')]);

    const storage = createBridgeMaskStorage(() => api);
    expect(await storage.list(assetPath('masks/abc'))).toEqual(['masks/abc/0.rle']);
  });

  it('is empty for a folder that has never existed, which every first run has', async () => {
    const { api } = fakeBridge();
    expect(await createBridgeMaskStorage(() => api).list(assetPath('masks/new'))).toEqual([]);
  });
});

describe('reading and writing', () => {
  it('passes a frame through unchanged', async () => {
    const { api, writeTextFile } = fakeBridge();
    await createBridgeMaskStorage(() => api).write(assetPath('masks/abc/7.rle'), '0 4 2 9');

    expect(writeTextFile).toHaveBeenCalledWith('masks/abc/7.rle', '0 4 2 9');
  });

  it('reports a missing frame as missing rather than as empty', async () => {
    // The cache treats `undefined` as a miss and an empty string as a frame with no runs; conflating
    // them would turn an absent file into a mask covering nothing.
    const { api, readTextFile } = fakeBridge();
    readTextFile.mockResolvedValue(undefined);

    expect(await createBridgeMaskStorage(() => api).read(assetPath('masks/abc/7.rle'))).toBeUndefined();
  });

  it('trashes a folder rather than unlinking it', async () => {
    // Like everything else this application removes from a project folder: the user's undo is their
    // file manager.
    const { api, trashEntry } = fakeBridge();
    await createBridgeMaskStorage(() => api).remove(assetPath('masks/abc'));

    expect(trashEntry).toHaveBeenCalledWith('masks/abc');
  });
});

describe('with no shell', () => {
  it('degrades to masks that live only in memory rather than throwing', async () => {
    // A build without the bridge — the component harness, a test — must still be able to segment.
    const storage = createBridgeMaskStorage(() => undefined);

    expect(await storage.read(assetPath('masks/a/0.rle'))).toBeUndefined();
    expect(await storage.list(assetPath('masks/a'))).toEqual([]);
    await expect(storage.write(assetPath('masks/a/0.rle'), 'x')).resolves.toBeUndefined();
    await expect(storage.remove(assetPath('masks/a'))).resolves.toBeUndefined();
  });
});
