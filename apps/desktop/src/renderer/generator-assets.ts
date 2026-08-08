import { PROJECT_FOLDERS } from '@nos/core';
import { type AssetChoice } from '@nos/generators';
import { type DirectoryNode, allFiles } from '@nos/media';

/**
 * The project's files, as things a generator parameter can be set to.
 *
 * The bridge between "a project is a folder" and a manifest's declared inputs: an image-to-video
 * generator asks for an image, and the images that exist are the ones in this project. Nothing here
 * knows which generator is asking — the filtering by type happens in `@nos/generators`, against the
 * parameter's declaration.
 *
 * Kept out of the panel and out of the tree component because it is a decision, not plumbing, and the
 * two decisions below are both ones a rendering test cannot make:
 *
 * - **What is offerable.** Only files the application could type, and never anything under `cache/` —
 *   those are derived, disposable, and regenerated under different names, so a run pinned to one
 *   would stop reproducing the moment the cache was cleared.
 * - **What it is called.** A bare filename while that is unambiguous, and the project-relative path
 *   the moment two folders hold the same name. A list showing `frame.png` twice is worse than one
 *   showing two long paths, because it looks like it works.
 */
export function assetChoicesFrom(tree: DirectoryNode | undefined): readonly AssetChoice[] {
  if (tree === undefined) return [];

  const files = allFiles(tree).filter(
    (file) =>
      file.assetType !== undefined &&
      file.path !== PROJECT_FOLDERS.cache &&
      !file.path.startsWith(`${PROJECT_FOLDERS.cache}/`),
  );

  const nameCounts = new Map<string, number>();
  for (const file of files) nameCounts.set(file.name, (nameCounts.get(file.name) ?? 0) + 1);

  return files
    .map((file) => ({
      path: file.path,
      // `assetType` is narrowed by the filter above; the cast states what the filter proved.
      type: file.assetType as NonNullable<typeof file.assetType>,
      label: (nameCounts.get(file.name) ?? 0) > 1 ? file.path : file.name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
}
