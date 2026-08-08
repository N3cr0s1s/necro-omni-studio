import { useCallback, useEffect, useState } from 'react';
import { type EffectRegistry, type RawManifest, BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import type { DesktopBridge } from '../main/ipc-contract.js';
import { bridge } from './bridge.js';
import type { LibraryProblem } from './use-generator-library.js';

/**
 * The project's own effects.
 *
 * §4 reserves `effects/` for "projekt-lokális shaderek + manifestek" and §6.3 defines an effect as a
 * GLSL fragment shader plus a manifest — which is to say the effect system was designed from the start
 * to be extended by dropping two files into a folder. The folder was created by the project scaffolder
 * and **nothing ever read it**: every effect in the application was one of the six shipped builtins,
 * and the extension point §7 asks for did not exist.
 *
 * The shape mirrors `use-generator-library` deliberately, because it is the same problem: read a
 * folder, validate what is in it, collect the failures rather than throwing them, and hand the result
 * to a registry that knows nothing about where it came from. A user who has learned how one works has
 * learned both.
 *
 * ## Why the shader is read here
 *
 * `RawManifest` carries `shaderSource` rather than a filename, because the registry has to work in the
 * renderer and in a test with inline strings. Resolving it is therefore the loader's job: a manifest
 * naming a shader that is not beside it is a *distinct* failure from a malformed manifest — the fix is
 * different, so the message has to be too.
 */

/** Where project-local effects live, per the spec's project layout. */
export const EFFECTS_FOLDER = 'effects';

export interface EffectLibrary {
  readonly registry: EffectRegistry;
  /** Manifests read from the project, before the registry has judged them. */
  readonly local: readonly RawManifest[];
  /** Files that could not be read or parsed at all, so they never reached the registry. */
  readonly problems: readonly LibraryProblem[];
  readonly loading: boolean;
  reload(): void;
}

export interface LoadEffectsResult {
  readonly local: readonly RawManifest[];
  readonly problems: readonly LibraryProblem[];
}

/**
 * Reads every manifest in the project's `effects/` folder, with the shader each one names.
 *
 * A manifest is any `*.json`; unlike `generators/` there is no second kind of file to tell apart, so
 * there is no `.manifest.json` convention to observe. The shader is whatever the manifest's `shader`
 * field names, resolved beside it.
 */
export async function loadEffects(api: DesktopBridge): Promise<LoadEffectsResult> {
  const entries = await api.listFolder(EFFECTS_FOLDER).catch(() => []);
  const local: RawManifest[] = [];
  const problems: LibraryProblem[] = [];

  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;

    const text = await api.readTextFile(entry.path).catch(() => undefined);
    if (text === undefined) {
      problems.push({ file: entry.name, detail: 'could not be read' });
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      problems.push({ file: entry.name, detail: `is not valid JSON: ${String(error)}` });
      continue;
    }

    // The shader beside the manifest. Left `undefined` when the manifest does not name one or the file
    // is missing — the registry reports that as its own status, with the shader's name in the message,
    // because "the manifest is wrong" and "the shader is not there" have different fixes.
    const shaderName = readShaderName(json);
    const shaderSource =
      shaderName === undefined
        ? undefined
        : await api.readTextFile(`${EFFECTS_FOLDER}/${shaderName}`).catch(() => undefined);

    local.push({ origin: entry.path, json, shaderSource });
  }

  return { local, problems };
}

/** The `shader` field, read without trusting the file to be a manifest at all. */
function readShaderName(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const shader = (json as { shader?: unknown }).shader;
  return typeof shader === 'string' && shader !== '' ? shader : undefined;
}

/**
 * @param root The open project. Reading `effects/` before one is open lists nothing, so the load has
 * to wait for it — and re-run when the user opens another, since the effects belong to the project.
 */
export function useEffectLibrary(root: string | undefined): EffectLibrary {
  const [local, setLocal] = useState<readonly RawManifest[]>([]);
  const [problems, setProblems] = useState<readonly LibraryProblem[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const api = bridge();
    if (api === undefined || root === undefined) {
      // No project, no project-local effects — and emphatically not the *previous* project's, which
      // is what keeping them would mean after opening another.
      setLocal([]);
      setProblems([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void loadEffects(api).then((result) => {
      if (cancelled) return;
      setLocal(result.local);
      setProblems(result.problems);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [root, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  /*
   * The project's effects come **after** the builtins, so a project can replace one by declaring the
   * same id. That is the useful direction: a shipped effect is a starting point, and a project that
   * wants its own film grain should get its own without having to pick a different name for it.
   */
  const [registry, setRegistry] = useState<EffectRegistry>(() => createEffectRegistry(BUILTIN_EFFECTS));
  useEffect(() => {
    setRegistry(createEffectRegistry([...BUILTIN_EFFECTS, ...local]));
  }, [local]);

  return { registry, local, problems, loading, reload };
}
