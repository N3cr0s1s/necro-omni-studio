import { useCallback, useEffect, useState } from 'react';
import {
  type GeneratorManifest,
  type GeneratorRegistry,
  createGeneratorRegistry,
  parseManifestFile,
} from '@nos/generators';
import type { DesktopBridge, FolderEntry } from '../main/ipc-contract.js';
import { bridge } from './bridge.js';

/**
 * The project's generator library.
 *
 * The spec's §5.6: on startup the application reads the project's `generators/` folder, validates every
 * manifest, and builds the registry. Nothing here knows what a generator *is* — it reads JSON files and
 * hands them to the registry, which is the whole point of the framework.
 *
 * Failures are collected rather than thrown. One malformed manifest must not stop the other eight from
 * loading; it appears in `problems` with its parse errors, which is the same rule the registry follows
 * for a manifest whose graph is missing.
 */

/** Where manifests and graphs live, per the spec's project layout. */
export const GENERATORS_FOLDER = 'generators';

export interface LibraryProblem {
  readonly file: string;
  readonly detail: string;
}

export interface GeneratorLibrary {
  readonly registry: GeneratorRegistry | undefined;
  readonly manifests: readonly GeneratorManifest[];
  /** Parsed graphs by filename, which the runtime needs in order to patch a submit. */
  readonly graphs: ReadonlyMap<string, unknown>;
  /** Files that could not be read or parsed at all, so they never reached the registry. */
  readonly problems: readonly LibraryProblem[];
  /**
   * Where the shared library lives on disk, for an empty state to name.
   *
   * A folder generators are read from that is never written down anywhere is a folder nobody puts a
   * generator in. `undefined` until the main process answers, and on any host that has no bridge.
   */
  readonly libraryPath: string | undefined;
  readonly loading: boolean;
  reload(): void;
}

export interface LoadLibraryResult {
  readonly manifests: readonly GeneratorManifest[];
  readonly graphs: ReadonlyMap<string, unknown>;
  readonly problems: readonly LibraryProblem[];
}

/**
 * Reads every manifest and graph in the project's `generators/` folder.
 *
 * A manifest is any `*.manifest.json`; every other `.json` is treated as a graph. The convention is what
 * lets a user drop a ComfyUI export straight into the folder and bind a manifest to it without renaming
 * anything or editing a registry file.
 */
export async function loadLibrary(api: DesktopBridge): Promise<LoadLibraryResult> {
  const manifests: GeneratorManifest[] = [];
  const graphs = new Map<string, unknown>();
  const problems: LibraryProblem[] = [];

  /*
   * The shared library first, the project's second, per §5.6's "the project's `generators/` folder
   * **and the global library**". Only the project's was ever read, so every new project started with
   * no generators at all and a user had to copy five manifests into each one by hand.
   *
   * Order is the override rule: a project manifest declaring an id the library already has replaces
   * it, because a project that ships its own version of a generator means to use that one. It is the
   * same direction the effect library takes with the builtins, and for the same reason.
   */
  const sources = [
    { where: 'library' as const, entries: await listing(() => api.listLibrary('')) },
    { where: 'project' as const, entries: await listing(() => api.listFolder(GENERATORS_FOLDER)) },
  ];

  for (const source of sources) {
    for (const entry of source.entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;

      const text = await reading(() =>
        source.where === 'library' ? api.readLibraryFile(entry.path) : api.readTextFile(entry.path),
      );
      if (text === undefined) {
        problems.push({ file: entry.name, detail: 'could not be read' });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        problems.push({ file: entry.name, detail: `is not valid JSON: ${String(error)}` });
        continue;
      }

      if (!entry.name.endsWith('.manifest.json')) {
        graphs.set(entry.name, parsed);
        continue;
      }

      const manifest = parseManifestFile(parsed);
      if (manifest.ok) {
        // Replaced rather than appended when the id is already there, so the project's wins and the
        // registry never sees two manifests claiming to be the same generator.
        const existing = manifests.findIndex((entry) => entry.id === manifest.value.id);
        if (existing === -1) manifests.push(manifest.value);
        else manifests[existing] = manifest.value;
      } else {
        // Collected, never thrown: one bad file must not take the other eight with it.
        problems.push({
          file: source.where === 'library' ? `library/${entry.name}` : entry.name,
          detail: manifest.error.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        });
      }
    }
  }

  return { manifests, graphs, problems };
}

/**
 * A folder listing, or nothing at all.
 *
 * Wrapped rather than `.catch()`-ed because this function's whole contract is that it does not throw —
 * and a bridge without the method throws *synchronously*, which a promise catch never sees. That is
 * not hypothetical: it is what a stub bridge in a test does, and what an older preload would do.
 */
async function listing(read: () => Promise<readonly FolderEntry[]>): Promise<readonly FolderEntry[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

async function reading(read: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

export interface LibraryOptions {
  /** Node classes the backend reports. `undefined` means it has not answered yet. */
  readonly installedNodeClasses?: ReadonlySet<string>;
  readonly backends?: ReadonlySet<string>;
}

export function useGeneratorLibrary(
  root: string | undefined,
  options: LibraryOptions = {},
): GeneratorLibrary {
  const [registry, setRegistry] = useState<GeneratorRegistry | undefined>(undefined);
  const [manifests, setManifests] = useState<readonly GeneratorManifest[]>([]);
  const [graphs, setGraphs] = useState<ReadonlyMap<string, unknown>>(new Map());
  const [problems, setProblems] = useState<readonly LibraryProblem[]>([]);
  const [libraryPath, setLibraryPath] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  // Once, not per reload: the folder does not move while the application is running, and it is wanted
  // even with no project open — that is exactly when the empty state has to say where to put a file.
  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;
    void Promise.resolve()
      .then(() => api.libraryPath())
      .then(setLibraryPath)
      .catch(() => setLibraryPath(undefined));
  }, []);

  const installed = options.installedNodeClasses;
  const backends = options.backends;

  const reload = useCallback(() => {
    const api = bridge();
    if (api === undefined || root === undefined) {
      setRegistry(undefined);
      setManifests([]);
      setGraphs(new Map());
      setProblems([]);
      return;
    }

    setLoading(true);
    void loadLibrary(api)
      .then((result) => {
        setManifests(result.manifests);
        setGraphs(result.graphs);
        setProblems(result.problems);
        setRegistry(
          createGeneratorRegistry(result.manifests, {
            graphs: result.graphs,
            // Omitted rather than empty when the backend has not answered: an empty set means "nothing
            // is installed" and would grey every generator while ComfyUI is still starting.
            ...(installed !== undefined ? { installedNodeClasses: installed } : {}),
            backends: backends ?? new Set(['comfyui', 'mock']),
          }),
        );
      })
      .finally(() => setLoading(false));
  }, [root, installed, backends]);

  useEffect(reload, [reload]);

  return { registry, manifests, graphs, problems, libraryPath, loading, reload };
}
