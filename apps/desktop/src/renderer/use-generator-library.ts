import { useCallback, useEffect, useState } from 'react';
import {
  type GeneratorManifest,
  type GeneratorRegistry,
  createGeneratorRegistry,
  parseManifestFile,
} from '@nos/generators';
import type { DesktopBridge } from '../main/ipc-contract.js';

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
  const entries = await api.listFolder(GENERATORS_FOLDER).catch(() => []);
  const manifests: GeneratorManifest[] = [];
  const graphs = new Map<string, unknown>();
  const problems: LibraryProblem[] = [];

  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;

    const text = await api.readTextFile(entry.path).catch(() => undefined);
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
      manifests.push(manifest.value);
    } else {
      // Collected, never thrown: one bad file must not take the other eight with it.
      problems.push({
        file: entry.name,
        detail: manifest.error.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      });
    }
  }

  return { manifests, graphs, problems };
}

export interface LibraryOptions {
  /** Node classes the backend reports. `undefined` means it has not answered yet. */
  readonly installedNodeClasses?: ReadonlySet<string>;
  readonly backends?: ReadonlySet<string>;
}

function bridge(): DesktopBridge | undefined {
  return (globalThis as { nos?: DesktopBridge }).nos;
}

export function useGeneratorLibrary(
  root: string | undefined,
  options: LibraryOptions = {},
): GeneratorLibrary {
  const [registry, setRegistry] = useState<GeneratorRegistry | undefined>(undefined);
  const [manifests, setManifests] = useState<readonly GeneratorManifest[]>([]);
  const [graphs, setGraphs] = useState<ReadonlyMap<string, unknown>>(new Map());
  const [problems, setProblems] = useState<readonly LibraryProblem[]>([]);
  const [loading, setLoading] = useState(false);

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

  return { registry, manifests, graphs, problems, loading, reload };
}
