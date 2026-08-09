import type { WorkspaceTabKind } from './workspace.js';

/**
 * What opening a file in the browser should do.
 *
 * Issue #32: double-clicking a `.frag` said *"…is not something that can go on the timeline"*, which
 * is true and useless. A shader is not timeline material, but it is very much something the
 * application can open — it had an editor as of yesterday, and no way to reach it that did not start
 * with selecting a clip.
 *
 * So a project folder is not only a bag of media. Some of its files are *sources*: shaders,
 * manifests, notes. Double-clicking one should open it, and which editor depends on the file.
 *
 * ## Why a table and not a chain of ifs
 *
 * Every new editor is a row. The browser stays ignorant of what a `.frag` is — it asks this what to do
 * and does it — which is the same shape as the workspace's tab kinds and for the same reason: the
 * next editor someone wants should not require finding every place that opens a file.
 */

/** What the shell should do with a file the user activated. */
export type FileAction =
  /** Put it on the timeline. Media, and the reason the browser exists. */
  | { readonly kind: 'timeline' }
  /** Open it in a workspace tab of this kind, addressed by the given subject. */
  | { readonly kind: 'tab'; readonly tab: WorkspaceTabKind; readonly subject: string }
  /** Nothing sensible to do, with a reason worth saying out loud. */
  | { readonly kind: 'none'; readonly reason: string };

interface SourceKind {
  readonly extensions: readonly string[];
  readonly tab: WorkspaceTabKind;
  readonly what: string;
}

/**
 * Files that are *sources* rather than media.
 *
 * `.frag` opens the effect editor, because a shader is one half of an effect and the editor holds
 * both halves. Everything else textual opens the text editor — a manifest, a note, a graph.
 */
export const SOURCE_KINDS: readonly SourceKind[] = [
  { extensions: ['.frag', '.glsl'], tab: 'effect', what: 'a shader' },
  { extensions: ['.json', '.md', '.txt'], tab: 'text', what: 'a text file' },
];

/** Extensions the timeline can take. Anything here goes to the timeline and never to an editor. */
export const TIMELINE_EXTENSIONS: readonly string[] = [
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.wav',
  '.mp3',
  '.flac',
  '.aac',
  '.ogg',
  '.m4a',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
];

/** Everything after the final dot, lowercased, with it. A file with no dot has none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * What to do with an activated file.
 *
 * Media first, because that is what the browser is mostly for and a `.png` used as a generator input
 * is still a picture. Sources second. Anything else is honestly nothing — and says what it is rather
 * than what it is not.
 */
export function actionFor(path: string): FileAction {
  const extension = extensionOf(path);
  if (TIMELINE_EXTENSIONS.includes(extension)) return { kind: 'timeline' };

  const source = SOURCE_KINDS.find((kind) => kind.extensions.includes(extension));
  if (source !== undefined) {
    return { kind: 'tab', tab: source.tab, subject: path };
  }

  return {
    kind: 'none',
    reason:
      extension === ''
        ? `${path} has no extension, so there is nothing to open it with`
        : `nothing here opens ${extension} files`,
  };
}

/**
 * The effect a shader belongs to, given the manifests in the project.
 *
 * A `.frag` is half of an effect: the other half is the manifest naming it, and the editor is opened
 * on the *effect*, not on the file. Matched by the shader the manifest actually names rather than by
 * filename convention, because a manifest is free to name any shader beside it.
 *
 * `undefined` when no manifest claims it — an orphan shader, which is a real thing to have while one
 * is being written and is not an error.
 */
export function effectForShader(
  path: string,
  manifests: readonly { readonly id: string; readonly shader: string }[],
): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return manifests.find((manifest) => manifest.shader === name)?.id;
}
