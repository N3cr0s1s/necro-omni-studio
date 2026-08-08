import type { AssetPath } from '@nos/core';
import type { MaskStorage } from '@nos/masks';
import type { DesktopBridge } from '../main/ipc-contract.js';

/**
 * The mask cache, on the project folder.
 *
 * `@nos/masks` has had a cache with a content-addressed key since M11 — keyed on the source, the
 * range and the prompt *order*, so re-running with the same clicks is a hit and reordering them is
 * correctly a miss — and it was tested against an in-memory storage and never given a real one.
 *
 * The consequence was quiet and total: masks lived in React state alone. Selecting another clip kept
 * them, closing the application did not, and a project reopened the next morning had an effect bound
 * to a mask that no longer existed anywhere. The effect then rendered *unmasked*, which looks like the
 * mask being wrong rather than the mask being gone — and §6.6 asks for exactly this cache, under
 * `masks/`.
 *
 * ## Why text and not binary
 *
 * A frame is run-length counts, and `countsToString` already writes the compact form COCO uses. The
 * bridge moves text; adding a binary channel to move what is already a short ASCII string would be
 * work in exchange for nothing. A mask of a 1080p subject is a few kilobytes.
 */

export function createBridgeMaskStorage(bridge: () => DesktopBridge | undefined): MaskStorage {
  return {
    async read(path) {
      return (await bridge()?.readTextFile(path)) ?? undefined;
    },

    async write(path, text) {
      const api = bridge();
      if (api === undefined) return;
      // The folder is created on the way: a cache key names a directory that has never existed, and
      // `writeTextFile` is the only thing that knows how to make one.
      await api.writeTextFile(path, text);
    },

    async list(folder) {
      const entries = await bridge()?.listFolder(folder);
      if (entries === undefined) return [];
      // The entry's own path, not one reassembled from the folder and the name: the bridge already
      // returns project-relative paths with forward slashes on every platform, and rebuilding one is
      // a second definition of what a path looks like.
      return entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path as AssetPath);
    },

    async remove(folder) {
      // Trashed rather than deleted, like everything else this application removes from a project
      // folder: a cache is regenerable in principle and expensive in practice, and the user's own
      // undo for a mistake here is their file manager.
      await bridge()?.trashEntry(folder);
    },
  };
}
