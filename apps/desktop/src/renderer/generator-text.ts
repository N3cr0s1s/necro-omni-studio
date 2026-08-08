import { PROJECT_FOLDERS, type TimelineDocument, clipId, locateClip } from '@nos/core';
import { type TextChoice, previewOf } from '@nos/generators';
import { type DirectoryNode, allFiles } from '@nos/media';

/**
 * The project's writing, as things a text parameter can be set to.
 *
 * The counterpart of `assetChoicesFrom`, and it exists for the same reason: the spec's §10 says a
 * text-to-speech script may come from a `notes/` file or from a text clip already on the timeline, and
 * the manifests declare exactly that — but a script that was already written could only be voiced by
 * finding it and typing it out again.
 *
 * Two decisions live here rather than in the panel, because both are about *this project* and neither
 * is something a rendering test could make:
 *
 * - **What counts as writing.** Files under `notes/` only. Every other folder holds material, and a
 *   picker that offered `project.json` as a script would be offering a mistake.
 * - **What it is called.** A clip by its label, a file by its name — and both carry their opening
 *   words, because a script is recognised by how it starts long before it is recognised by being
 *   called `script_2.md`.
 *
 * The file previews are filled in by the caller once it has read them; a listing knows names, not
 * contents, and blocking a panel render on reading every note would be the wrong trade.
 */

/** Extensions treated as writing. Anything else under `notes/` is left alone rather than guessed at. */
const NOTE_EXTENSIONS = ['.md', '.txt'];

export function noteChoicesFrom(tree: DirectoryNode | undefined): readonly TextChoice[] {
  if (tree === undefined) return [];

  return allFiles(tree)
    .filter(
      (file) =>
        (file.path === PROJECT_FOLDERS.notes || file.path.startsWith(`${PROJECT_FOLDERS.notes}/`)) &&
        NOTE_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension)),
    )
    .map((file) => ({
      source: 'notes_file' as const,
      ref: file.path,
      label: file.name,
      // Filled in by the caller after reading. Empty rather than a placeholder, so a note that has not
      // been read yet is visually the same as one that is genuinely empty — which it may well be.
      preview: '',
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
}

/**
 * Text clips on the timeline, in the order they play.
 *
 * Playback order rather than track order: a script read aloud follows the cut, and a list sorted by
 * track would interleave two titles that appear a minute apart.
 */
export function clipChoicesFrom(document: TimelineDocument): readonly TextChoice[] {
  const clips = document.sequence.tracks
    .filter((track) => track.kind === 'text')
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === 'text');

  return [...clips]
    .sort((left, right) => left.span.start - right.span.start)
    .map((clip) => ({
      source: 'text_clip' as const,
      ref: clip.id,
      // The label a user gave it, falling back to the text itself — an untitled clip is identified by
      // what it says, which is the only thing about it the user chose.
      label: clip.label ?? previewOf(clip.content.text, 32),
      preview: previewOf(clip.content.text),
    }));
}

/** Everything a text parameter could draw on, both sources in one list. */
export function textChoicesFrom(
  tree: DirectoryNode | undefined,
  document: TimelineDocument,
): readonly TextChoice[] {
  return [...noteChoicesFrom(tree), ...clipChoicesFrom(document)];
}

/**
 * The text a chosen source resolves to.
 *
 * Returns `undefined` when it cannot be resolved — a note deleted since the panel listed it, a clip
 * removed from the timeline — so the caller can refuse the run and say why. Substituting an empty
 * string would submit a job that generates silence and reports success.
 */
export async function resolveTextChoice(
  choice: TextChoice,
  document: TimelineDocument,
  readFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  if (choice.source === 'text_clip') {
    // Through `locateClip` rather than a flat scan: it is the one definition of "find this clip", and
    // the tracks are a union whose `clips` arrays do not flatten to a single type.
    const located = locateClip(document, clipId(choice.ref));
    return located?.clip.kind === 'text' ? located.clip.content.text : undefined;
  }

  if (choice.source === 'notes_file') {
    try {
      return await readFile(choice.ref);
    } catch {
      return undefined;
    }
  }

  return undefined;
}
