import type { languages } from 'monaco-editor/editor/editor.api.js';

/**
 * JSON, as a Monarch grammar — issue #35.
 *
 * Monaco's own JSON support is a *language service*: it runs in a web worker and brings schema
 * validation and completion with it. Two reasons it is not used here.
 *
 * The worker needs `worker-src` opened in the renderer's CSP, which exists to make it impossible for
 * this window to execute anything it was not shipped with. That is a large concession for a
 * highlighter.
 *
 * And its two features are already answered, better, by this codebase. Validation is
 * `serialization/`, which knows what a manifest actually is and reports the offending path.
 * Completion is the schema descriptions from issue #31, written as records over the manifest types so
 * the compiler proves they are complete. A JSON Schema handed to Monaco would be a second, weaker
 * description of the same documents — and the day the two disagreed, the editor would suggest a field
 * the loader rejects.
 *
 * So what is missing is only the colouring, which is a tokenizer, which is this file.
 */

export const JSON_LANGUAGE_ID = 'json';

export const JSON_CONFIGURATION: languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"', notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
};

export const JSON_TOKENS: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.json',

  tokenizer: {
    root: [
      /*
       * A string followed by a colon is a property name.
       *
       * The distinction is the whole reason a manifest is readable at a glance — keys are what you
       * scan for and values are what you read — and it is the same rule the previous tokenizer and
       * the caret scanner both arrived at independently. The lookahead allows whitespace between the
       * closing quote and the colon, because a formatter may put it there.
       */
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/u, 'string.key.json'],
      [/"(?:[^"\\]|\\.)*"/u, 'string.value.json'],
      // An unterminated string, which is what every string is while it is being typed. Coloured as a
      // string rather than left plain, so the line does not change colour under the cursor.
      [/"(?:[^"\\]|\\.)*$/u, 'string.value.json'],

      [/[{}[\]]/u, '@brackets'],
      [/[,:]/u, 'delimiter'],

      [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/u, 'number'],
      [/\b(?:true|false|null)\b/u, 'keyword'],

      // Comments are not JSON, and this application refuses to save a file that does not parse. They
      // are coloured anyway: someone pasting an annotated example should see why it will not save,
      // rather than watch the highlighting fall apart with no explanation.
      [/\/\/.*$/u, 'comment'],
      [/\/\*/u, 'comment', '@comment'],

      [/[ \t\r\n]+/u, ''],
    ],

    comment: [
      [/[^/*]+/u, 'comment'],
      [/\*\//u, 'comment', '@pop'],
      [/[/*]/u, 'comment'],
    ],
  },
};
