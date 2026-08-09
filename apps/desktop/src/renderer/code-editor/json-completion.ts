import { type SchemaShape, completionsFor, locationAt } from '@nos/core';
import { monaco } from './CodeEditor.js';

/**
 * The manifest completions from issue #31, offered through Monaco — issue #35.
 *
 * Monaco has a JSON language service of its own that does exactly this from a JSON Schema. It is not
 * used, for the same reason the descriptions were not written as JSON Schema in the first place: this
 * application already knows what a valid manifest is, in `serialization/`, and a second structurally
 * different description would give it two answers to that question. The day they disagree, the editor
 * suggests a field the loader rejects.
 *
 * Adopting Monaco therefore changes the *widget*, not the knowledge. `locationAt` still answers where
 * the caret is, `completionsFor` still answers what belongs there, and both are still tested without
 * a DOM. This file is the adapter, and it is deliberately the only part that knows Monaco exists.
 */

/** Which description applies to a model, by its path. `undefined` offers nothing. */
export type SchemaLookup = (path: string) => SchemaShape | undefined;

/**
 * Registers the provider once, against every JSON model.
 *
 * Returns a disposer, though in practice this lives for the window: Monaco keeps providers per
 * language, not per editor, so registering per mounted editor would stack duplicates and offer every
 * suggestion N times.
 */
export function registerJsonCompletions(lookup: SchemaLookup): { dispose: () => void } {
  return monaco.languages.registerCompletionItemProvider('json', {
    // The characters that should open the list unasked. A quote starts a name or a value; a colon
    // and a comma are the moments a new one becomes possible.
    triggerCharacters: ['"', ':', ',', '{', '['],

    provideCompletionItems(model, position) {
      const shape = lookup(pathOf(model.uri));
      if (shape === undefined) return { suggestions: [] };

      const source = model.getValue();
      const offset = model.getOffsetAt(position);
      const location = locationAt(source, offset);
      const completions = completionsFor(shape, location);
      if (completions.length === 0) return { suggestions: [] };

      // The span the insertion replaces, converted from offsets. Monaco needs a range; the location
      // already knows exactly which token is being replaced, including the tail past the caret.
      const start = model.getPositionAt(location.replaceFrom);
      const end = model.getPositionAt(location.replaceTo);
      const range = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };

      return {
        suggestions: completions.map((completion, index) => ({
          label: completion.label,
          kind:
            completion.kind === 'property'
              ? monaco.languages.CompletionItemKind.Property
              : monaco.languages.CompletionItemKind.Value,
          detail: completion.detail ?? '',
          documentation: completion.doc ?? '',
          insertText: completion.insert,
          range,
          /*
           * The schema's own order, preserved.
           *
           * A manifest has a shape its author had in mind — identity, then what it takes and makes,
           * then how it runs — and Monaco sorts alphabetically unless told otherwise. `sortText` is
           * compared as a string, so the index is padded: without that, item 10 sorts before item 2.
           */
          sortText: String(index).padStart(4, '0'),
          // Required fields first among equals, so a half-written manifest shows what it still owes.
          preselect: completion.required === true && index === 0,
        })),
      };
    },
  });
}

/**
 * The project-relative path a model URI carries.
 *
 * Models are created as `nos:///<project path>`, so the path is the URI's own path with its leading
 * slash removed. Decoded, because a filename with a space arrives percent-encoded and the schema
 * registry matches on the real name.
 */
export function pathOf(uri: { readonly path: string }): string {
  return decodeURIComponent(uri.path.replace(/^\//u, ''));
}
