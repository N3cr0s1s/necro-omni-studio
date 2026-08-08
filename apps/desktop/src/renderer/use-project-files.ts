import { useCallback, useState } from 'react';
import type { DesktopBridge } from '../main/ipc-contract.js';
import { movedPath, renamedPath, sanitizeFolderName } from './browser-menu.js';

/**
 * Organising the project folder from inside the application.
 *
 * The browser could show the folder and do nothing to it. "A project is a folder" held right up to
 * the point where you wanted to tidy one, and then you had to leave — which also meant the
 * application's own view of the project was whatever the last scan happened to catch.
 *
 * Every operation is refused *here* before it reaches the disk when it would mean nothing — a rename
 * to the same name, a move into the folder something already sits in — so the watcher is not woken
 * for a no-op and the user is not told a file was moved when it was not. What is left is the errors
 * only the filesystem can report, which arrive as a sentence rather than an exception.
 */

export interface ProjectFiles {
  /** The last failure, kept until the next attempt so it can be shown rather than flashed. */
  readonly error: string | undefined;
  clearError(): void;
  createFolder(parent: string, name: string): Promise<boolean>;
  rename(path: string, name: string): Promise<boolean>;
  move(source: string, destinationFolder: string): Promise<boolean>;
  trash(path: string): Promise<boolean>;
}

export function useProjectFiles(bridge: () => DesktopBridge | undefined): ProjectFiles {
  const [error, setError] = useState<string | undefined>(undefined);

  const run = useCallback(
    async (operation: (api: DesktopBridge) => Promise<{ ok: boolean; detail?: string }>) => {
      const api = bridge();
      if (api === undefined) return false;

      setError(undefined);
      try {
        const result = await operation(api);
        if (!result.ok) setError(result.detail ?? 'the file could not be changed');
        return result.ok;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [bridge],
  );

  const createFolder = useCallback(
    async (parent: string, name: string) => {
      const cleaned = sanitizeFolderName(name);
      if (cleaned === undefined) return false;
      const path = parent === '' ? cleaned : `${parent}/${cleaned}`;
      return run((api) => api.createFolder(path));
    },
    [run],
  );

  const rename = useCallback(
    async (path: string, name: string) => {
      const target = renamedPath(path, name);
      // Undefined for a name that did not change, or one that would move or hide the file. Silent
      // rather than an error: the user typed something and then thought better of it, which is not a
      // failure and does not deserve to be reported as one.
      if (target === undefined) return false;
      return run((api) => api.moveEntry(path, target));
    },
    [run],
  );

  const move = useCallback(
    async (source: string, destinationFolder: string) => {
      const target = movedPath(source, destinationFolder);
      if (target === undefined) return false;
      return run((api) => api.moveEntry(source, target));
    },
    [run],
  );

  const trash = useCallback((path: string) => run((api) => api.trashEntry(path)), [run]);

  return {
    error,
    clearError: useCallback(() => setError(undefined), []),
    createFolder,
    rename,
    move,
    trash,
  };
}
