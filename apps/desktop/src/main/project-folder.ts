import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RecoverySnapshot } from './ipc-contract.js';

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

/** Mirrors `RECOVERY_FILE_NAME` in `@nos/core`; the name is part of the on-disk layout. */
export const RECOVERY_FILE = 'project.recovery.json';

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
  await writeAtomically(join(root, PROJECT_FILE), contents);
}

/**
 * Writes the crash-recovery sibling.
 *
 * Atomic for a sharper reason than `project.json`: a recovery file exists only because the process
 * may die at any moment, and one that dies mid-write leaves a torn file that the next launch would
 * offer as the user's unsaved work. A recovery file that cannot be trusted is worse than none.
 */
export async function writeRecoveryFile(root: string, contents: string): Promise<void> {
  await writeAtomically(join(root, RECOVERY_FILE), contents);
}

/**
 * Reads the recovery sibling with both timestamps.
 *
 * Both are read here, in one pass, because the decision they feed — is this newer than the saved
 * project? — is only sound if they describe the same moment. Two round trips could straddle a save
 * and offer the user work older than what is already on disk.
 */
export async function readRecoveryFile(root: string): Promise<RecoverySnapshot | undefined> {
  const target = join(root, RECOVERY_FILE);
  try {
    const [contents, recoveryStat] = await Promise.all([readFile(target, 'utf8'), stat(target)]);
    const projectModifiedAt = await modifiedAt(join(root, PROJECT_FILE));
    return {
      contents,
      modifiedAt: recoveryStat.mtimeMs,
      ...(projectModifiedAt !== undefined ? { projectModifiedAt } : {}),
    };
  } catch {
    // No recovery file is the normal case — every clean exit removes it.
    return undefined;
  }
}

export async function removeRecoveryFile(root: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(join(root, RECOVERY_FILE), { force: true });
}

async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function writeAtomically(target: string, contents: string): Promise<void> {
  const temporary = `${target}.partial`;
  await writeFile(temporary, contents, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(temporary, target);
}
