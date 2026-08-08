import type { GeneratorManifest, GeneratorParam, ConsumesDescriptor } from '../contracts/manifest.js';

/**
 * Where a text parameter's value comes from.
 *
 * The spec's §10 settles this for text-to-speech: a script may be *typed*, may be a file in `notes/`,
 * or may be a text clip already on the timeline. All three were declared in the manifest contract and
 * parsed into `ConsumesDescriptor.sources` — and read by nothing, so the only way to voice a line that was
 * already written was to find it and type it again.
 *
 * A named union rather than a boolean pair because the list is expected to grow: a caption track and a
 * script file outside the project are both plausible fourth entries, and each needs its own way of
 * being *resolved* to a string. That resolution deliberately does not live here — this package has no
 * filesystem and no document — so a caller supplies the choices and reads whichever one was picked.
 */

export const TEXT_SOURCES = ['inline', 'notes_file', 'text_clip'] as const;

export type TextSource = (typeof TEXT_SOURCES)[number];

export function isTextSource(value: string): value is TextSource {
  return (TEXT_SOURCES as readonly string[]).includes(value);
}

/**
 * One thing a text parameter could be set to, other than typing it.
 *
 * Carries a `preview` because the alternative is a list of file names and clip labels, and a script is
 * recognised by its opening words long before it is recognised by being called `script_2.md`. The same
 * reasoning that gives a generated take its prompt in the browser.
 */
export interface TextChoice {
  readonly source: TextSource;
  /** What to resolve: a project-relative path for a file, a clip id for a clip. */
  readonly ref: string;
  readonly label: string;
  /** The opening words, so the list is readable. Empty for something that could not be read yet. */
  readonly preview: string;
}

/**
 * The sources a text input declares, defaulting to typing it.
 *
 * Absent means `inline`, not "all of them": a manifest that says nothing about where its text comes
 * from is asking for a value, and silently offering to bind it to a timeline clip would invent an
 * intention its author never expressed.
 *
 * Unrecognized entries are dropped rather than rejected. A manifest written against a later build that
 * knows a fourth source should still work here for the sources this build does understand — the same
 * forward-compatibility rule the registry applies to node classes it has never heard of.
 */
export function textSourcesFor(input: ConsumesDescriptor | undefined): readonly TextSource[] {
  const declared = input?.sources;
  if (declared === undefined) return ['inline'];

  const known = declared.filter(isTextSource);
  // Never empty: a declaration listing only sources this build cannot serve still leaves typing, which
  // every text parameter supports by definition.
  return known.length === 0 ? ['inline'] : known;
}

/**
 * The input descriptor a parameter corresponds to, matched by role.
 *
 * `consumes` describes what the generator *needs* and `params` describes how it is *patched* into the
 * graph; the role is the only thing tying the two together, which is exactly why the manifest requires
 * one. Matching on the key as a fallback keeps a manifest that omitted the role working rather than
 * silently losing its sources.
 */
export function inputFor(manifest: GeneratorManifest, param: GeneratorParam): ConsumesDescriptor | undefined {
  return (
    manifest.consumes.find((input) => input.role !== undefined && input.role === param.key) ??
    manifest.consumes.find((input) => input.type === 'text' && param.type === 'text')
  );
}

/** Whether a parameter has anywhere to draw from other than the keyboard. */
export function hasAlternativeSources(sources: readonly TextSource[]): boolean {
  return sources.some((source) => source !== 'inline');
}

/** The choices that apply to one source, so a picker shows files or clips but never both at once. */
export function choicesForSource(choices: readonly TextChoice[], source: TextSource): readonly TextChoice[] {
  return choices.filter((choice) => choice.source === source);
}

/**
 * A short, single-line opening of some text.
 *
 * Collapses whitespace: a script's first line is often blank or indented, and a preview that begins
 * with an empty line looks like a file that failed to load.
 */
export function previewOf(text: string, maxLength = 80): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}
