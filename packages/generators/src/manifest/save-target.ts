/**
 * Where an authored manifest lands, and what is already there.
 *
 * A manifest is written to `generators/<id>.manifest.json`, so the id *is* the filename and two
 * generators cannot share one. The authoring screen wrote that path with no check at all: typing an id
 * a manifest in the library already had replaced it, silently and completely — including the ones that
 * ship with the project. An id is a short slug with no hint on screen of what is taken, so this is not
 * an exotic mistake.
 *
 * The same shape as the export dialog's answer to the same problem: overwriting on purpose is a
 * legitimate thing to do — it is exactly what saving a manifest you opened *is* — so this warns and
 * offers a free id rather than refusing. What was missing was the word.
 *
 * ## Why `editing` is a parameter
 *
 * Reopening `stable_audio_3`, changing a default and saving must not warn: replacing that file is the
 * whole point. The id being taken is only a surprise when it is taken by a manifest the user did not
 * open. Without this distinction the warning would appear on every ordinary edit and be learned as
 * noise.
 */

/** The project-relative file an id is written to. One place, so the check and the write cannot drift. */
export function manifestFileName(id: string): string {
  return `${id}.manifest.json`;
}

/**
 * A generator id nothing else has taken.
 *
 * Suffixed `_2`, not ` (2)`: an id is an identifier — it appears in a clip's provenance and in a
 * filename — and a space or a bracket in one is a difference every consumer has to think about.
 * Counting from 2 because the manifest already there is the first.
 */
export function freeGeneratorId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;

  // Bounded for the same reason `uniqueName` is: a thousand generators sharing a stem is not a case
  // worth serving, and stopping beats spinning.
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${id}_${attempt}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${id}_${taken.size + 1}`;
}

/** What saving this draft would do to the library. */
export interface SaveTarget {
  /** Project-relative path the manifest is written to. */
  readonly file: string;
  /** The id of a *different* manifest this would replace, or `undefined`. */
  readonly replaces: string | undefined;
  /** A free id, offered only when something would be replaced. */
  readonly free: string | undefined;
}

/**
 * Where this draft would be written, and whether that costs anything.
 *
 * `taken` is every id in the library. `editing` is the id the screen was opened on, absent when the
 * manifest is new — and it is deliberately the id rather than a boolean, because a user who reopens a
 * manifest and *renames* it is authoring a new one and should be warned if the new name is taken.
 */
export function saveTarget(id: string, taken: ReadonlySet<string>, editing?: string): SaveTarget {
  const file = manifestFileName(id);
  const replaces = id !== editing && taken.has(id) ? id : undefined;

  return {
    file,
    replaces,
    free: replaces === undefined ? undefined : freeGeneratorId(id, taken),
  };
}
