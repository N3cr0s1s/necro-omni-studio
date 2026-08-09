/**
 * Naming a file brought into a project.
 *
 * A project is a folder, so importing means *copying* rather than referencing: a link to somewhere
 * else on the machine would break §4's promise that zipping the folder moves the whole project, and
 * would break it invisibly — the cut plays perfectly until it is opened somewhere else.
 *
 * Copying means two files can want one name, and what happens then is the whole of this module. The
 * two obvious answers are both wrong: overwriting destroys material the cut may already be using, and
 * refusing makes the user rename things outside the editor to get them in.
 */

/** Everything after the final dot, with it, or empty. `archive.tar.gz` gives `.gz`, which is correct. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension: `.gitignore` has none.
  return dot <= 0 ? '' : name.slice(dot);
}

export function stemOf(name: string): string {
  const extension = extensionOf(name);
  return extension === '' ? name : name.slice(0, -extension.length);
}

/**
 * A name no file in `taken` already has.
 *
 * Numbered before the extension — `take (2).mp4`, not `take.mp4 (2)` — because the extension is what
 * every other program uses to decide what the file *is*, and a suffix after it makes the copy
 * unopenable.
 *
 * Counts from 2, because the file already there is the first one. Existing numbered copies are skipped
 * rather than reused, so importing the same file three times gives `(2)` and `(3)` instead of
 * repeatedly failing to find a free name.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;

  const stem = stemOf(name);
  const extension = extensionOf(name);

  // Bounded so a pathological folder cannot spin: a thousand copies of one name is not a case worth
  // serving, and stopping is better than hanging.
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${stem} (${attempt})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${stem} (${Date.now()})${extension}`;
}

/**
 * Where a set of imports should land, and under what names.
 *
 * Resolved as a batch rather than one at a time, because two files being imported together can want
 * the same name as each other — not only as something already in the folder. Importing `shot.mp4`
 * from two different cards at once is a normal thing to do and would otherwise silently drop one.
 */
export interface ImportPlacement {
  /** The absolute path the user chose, unchanged. */
  readonly from: string;
  /** Project-relative destination, folder included. */
  readonly to: string;
}

export function planImport(
  sources: readonly string[],
  folder: string,
  taken: ReadonlySet<string>,
): readonly ImportPlacement[] {
  const claimed = new Set(taken);
  const placements: ImportPlacement[] = [];

  for (const from of sources) {
    const name = uniqueName(baseName(from), claimed);
    claimed.add(name);
    placements.push({ from, to: folder === '' ? name : `${folder}/${name}` });
  }

  return placements;
}

/** The last path segment, for either separator, so a Windows path resolves on Linux too. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}
