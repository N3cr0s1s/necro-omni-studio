import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The project folder.
 *
 * The spec's model: a project **is** a folder, not a database — zipping it transfers everything. That
 * makes the main process's job small and its one real responsibility sharp: nothing the renderer asks
 * for may escape the folder the user opened.
 *
 * Containment is checked **after** resolution, not by inspecting the string. `../` is the obvious attack
 * and the easy one to catch; a symlink inside the project pointing at `/etc` is neither, and only a
 * post-resolution check catches both.
 */

/** Subfolders the spec's layout defines. Created on open so a fresh folder is immediately usable. */
export const PROJECT_SUBFOLDERS: readonly string[] = [
  'media',
  'generated',
  'masks',
  'effects',
  'generators',
  'notes',
  'renders',
  'cache',
];

export const PROJECT_FILE = 'project.json';

export class ProjectPathError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(`"${requested}" is outside the project folder`);
    this.name = 'ProjectPathError';
  }
}

/**
 * Resolves a project-relative path to an absolute one, refusing anything outside the root.
 *
 * The `relative()` check rather than a `startsWith` on the string: `/project-backup` starts with
 * `/project`, and a prefix test would happily hand out a neighbouring folder.
 */
export function resolveInProject(root: string, requested: string): string {
  if (isAbsolute(requested)) throw new ProjectPathError(requested, root);

  const rootResolved = resolve(root);
  const target = resolve(rootResolved, requested);
  const rel = relative(rootResolved, target);

  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ProjectPathError(requested, root);
  }
  return target;
}

/** The project-relative form of an absolute path, or `undefined` when it lies outside. */
export function toProjectRelative(root: string, absolute: string): string | undefined {
  const rel = relative(resolve(root), resolve(absolute));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  // Always forward slashes: asset identity is a project-relative path, and a project authored on
  // Windows must open on Linux with the same identities.
  return rel.split(sep).join('/');
}

/** Creates the spec's folder layout. Idempotent, so opening an existing project is harmless. */
export async function ensureLayout(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const folder of PROJECT_SUBFOLDERS) {
    await mkdir(join(root, folder), { recursive: true });
  }
}

export async function readProjectFile(root: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, PROJECT_FILE), 'utf8');
  } catch {
    // A folder with no `project.json` is a new project, not an error.
    return undefined;
  }
}

/**
 * Writes the project file.
 *
 * Through a temporary file and a rename, because the alternative is a truncated `project.json` after a
 * crash mid-write — which loses the entire edit, not the last change. The rename is atomic on every
 * filesystem this runs on.
 */
export async function writeProjectFile(root: string, contents: string): Promise<void> {
  const target = join(root, PROJECT_FILE);
  const temporary = `${target}.partial`;
  await writeFile(temporary, contents, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(temporary, target);
}
