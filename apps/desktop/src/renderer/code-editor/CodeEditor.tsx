import { type ReactNode, useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
/*
 * The features that make this an editor rather than a text box.
 *
 * Named one by one through Monaco's own per-feature `register.js` entry points, which is the
 * supported way to take part of the distribution. `editor.main.js` would bring all of them *and* the language
 * services, whose web workers the renderer's CSP forbids.
 *
 * The pre-0.56 way to do this was to import `editor/contrib/<name>/browser/<file>.js` directly. Those
 * files still exist and importing them registers nothing, so the editor came up looking correct with
 * no find, no suggestions and no hovers — a failure with no error anywhere. If a feature below stops
 * working after an upgrade, this is the first place to look.
 */
import 'monaco-editor/features/bracketMatching/register.js';
import 'monaco-editor/features/clipboard/register.js';
import 'monaco-editor/features/comment/register.js';
import 'monaco-editor/features/contextmenu/register.js';
import 'monaco-editor/features/cursorUndo/register.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/features/folding/register.js';
import 'monaco-editor/features/gotoLine/register.js';
import 'monaco-editor/features/hover/register.js';
import 'monaco-editor/features/indentation/register.js';
import 'monaco-editor/features/lineSelection/register.js';
import 'monaco-editor/features/linesOperations/register.js';
import 'monaco-editor/features/multicursor/register.js';
import 'monaco-editor/features/smartSelect/register.js';
import 'monaco-editor/features/suggest/register.js';
/*
 * The suggest *widget*, which the feature register above does not bring.
 *
 * `features/suggest/register.js` wires inline completions only — ghost text — and the popup list is a
 * separate contribution. Registering the first without the second gives an editor that computes
 * completions and has nowhere to show them, which looks exactly like a provider that returns nothing.
 */
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/features/wordOperations/register.js';
import { GLSL_CONFIGURATION, GLSL_LANGUAGE_ID, GLSL_TOKENS } from './glsl-language.js';
import { JSON_CONFIGURATION, JSON_LANGUAGE_ID, JSON_TOKENS } from './json-language.js';
import { MONACO_THEME_ID, buildMonacoTheme } from './monaco-theme.js';

/**
 * VS Code's editor, for every place this application edits text — issue #35.
 *
 * The previous editor was a transparent textarea over a `<pre>` painted by a hand-written tokenizer.
 * That was the right call while what was needed was colour; it is the wrong one now that the ask is
 * "a full editor". Find, multi-cursor, folding, bracket matching, comment toggling, indentation,
 * hovers and a real completion widget are not features to reimplement one at a time.
 *
 * ## What is imported, and what is deliberately not
 *
 * Monaco's language *services* — JSON, CSS, TypeScript — run in web workers, which the renderer's
 * CSP forbids without opening `worker-src`. None of them is wanted: this application already knows
 * what a valid manifest is, in `serialization/`, and already computes completions from the manifest
 * types themselves. So the imports are the editor core plus the contributions that are pure UI, and
 * every language — including JSON's own colouring — is registered from this codebase. The CSP stays
 * as strict as it was.
 *
 * The consequence worth stating: `import * as monaco from 'monaco-editor'` would pull the whole
 * distribution including those workers. The deep `esm/vs/editor/editor.api.js` entry point is what
 * keeps this to the editor.
 *
 * ## Why the model is keyed by path
 *
 * Monaco holds a model per URI, and a model carries undo history. Keying by the file's own path
 * means closing a tab and reopening it restores the undo stack, and two tabs on one file are one
 * model rather than two that can disagree.
 */

let configured = false;

/** Registers the languages and the theme once per window. */
function configureMonaco(): void {
  if (configured) return;
  configured = true;

  monaco.languages.register({ id: GLSL_LANGUAGE_ID, extensions: ['.frag', '.vert', '.glsl'] });
  monaco.languages.setLanguageConfiguration(GLSL_LANGUAGE_ID, GLSL_CONFIGURATION);
  monaco.languages.setMonarchTokensProvider(GLSL_LANGUAGE_ID, GLSL_TOKENS);

  monaco.languages.register({ id: JSON_LANGUAGE_ID, extensions: ['.json'] });
  monaco.languages.setLanguageConfiguration(JSON_LANGUAGE_ID, JSON_CONFIGURATION);
  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE_ID, JSON_TOKENS);
}

export interface CodeEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** `json`, `glsl`, or `plaintext` for anything else. */
  readonly language: string;
  /**
   * Identity of what is being edited, as a path.
   *
   * Decides which Monaco model backs the editor, and therefore which undo history it has.
   */
  readonly path: string;
  readonly readOnly?: boolean;
  /** Problems to underline, in editor coordinates. Replaces whatever was shown before. */
  readonly markers?: readonly CodeMarker[];
  /** Theme generation: bump it when the palette changes so the colours are measured again. */
  readonly themeKey?: string;
  readonly ariaLabel: string;
  readonly className?: string;
}

/** A problem to underline. Lines and columns are 1-based, as every compiler reports them. */
export interface CodeMarker {
  readonly line: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
}

export function CodeEditor({
  value,
  onChange,
  language,
  path,
  readOnly = false,
  markers,
  themeKey,
  ariaLabel,
  className,
}: CodeEditorProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  // Held in a ref so the change listener never goes stale without tearing the editor down and losing
  // the caret, the selection and the undo stack with it.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /*
   * The text a *new* model is seeded with.
   *
   * In a ref, because it must not be a dependency of the effect that builds the editor. It was, and
   * the consequence was severe enough to be worth naming: `onChange` sets the value, the value is a
   * dependency, so every keystroke disposed the editor and built a new one. The text survived — the
   * model outlives the editor — so it looked almost right, while the caret jumped, the scroll reset,
   * and any widget that was open closed before it could be read. A suggestion list cannot survive its
   * editor being rebuilt underneath it.
   */
  const seedRef = useRef(value);
  seedRef.current = value;

  useEffect(() => {
    const element = host.current;
    if (element === null) return;

    configureMonaco();
    monaco.editor.defineTheme(MONACO_THEME_ID, buildMonacoTheme());

    const uri = monaco.Uri.parse(`nos:///${path}`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(seedRef.current, language, uri);

    const editor = monaco.editor.create(element, {
      model,
      theme: MONACO_THEME_ID,
      readOnly,
      automaticLayout: true,
      fontSize: 12,
      lineHeight: 20,
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      minimap: { enabled: false },
      // The panel is narrow and a manifest's prose lines are long; wrapping is what keeps a value
      // readable without a horizontal scrollbar under every line.
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      // Off: this application has no notion of a workspace, so the only thing to jump to is itself.
      links: false,

      /*
       * Everything below keeps the editor off its background worker.
       *
       * Monaco starts one for word-based suggestions, occurrence highlighting and the syntax-aware
       * folding strategy. It is created from a `blob:` URL, which `script-src 'self'` refuses — and
       * the refusal surfaces as the suggest widget silently never appearing, not as an error anyone
       * would connect to folding.
       *
       * Opening `worker-src` in the CSP would be the other fix, and it is the wrong one: the CSP is
       * there so this window cannot execute anything it was not shipped with, and none of these three
       * features is wanted. Suggestions come from the manifest descriptions, which know far more than
       * a list of words already in the file; the rest are noise in a hundred-line manifest.
       */
      wordBasedSuggestions: 'off',
      occurrencesHighlight: 'off',
      foldingStrategy: 'indentation',
      tabSize: 2,
      padding: { top: 8, bottom: 8 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      /*
       * The classic hidden textarea rather than the EditContext API.
       *
       * EditContext is Monaco's newer input path and renders as a `contenteditable`-like div with no
       * form control behind it. The textarea is the long-standing one, and it is what assistive
       * technology, the platform's own spellcheck and every automation tool expect to find — the
       * harness that drives this window could not type into the EditContext element at all, which is
       * a fair proxy for what a screen reader would have made of it.
       */
      editContext: false,
    });

    instance.current = editor;
    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });

    return () => {
      subscription.dispose();
      editor.dispose();
      instance.current = undefined;
      // The model outlives the editor deliberately: reopening the same file restores its undo stack.
    };
    /*
     * Only what genuinely needs a different editor.
     *
     * A new file is a new model, and a new language is a new tokenizer — both are rebuilds. Everything
     * else about an editor can be changed on the living instance, and doing it that way is what keeps
     * the caret, the selection, the scroll position and the undo stack where the user left them.
     */
  }, [language, path]);

  // Options that can change without rebuilding. `ariaLabel` is here rather than in `create` for the
  // same reason: an effect being renamed must not cost the author their undo history.
  useEffect(() => {
    instance.current?.updateOptions({ readOnly, ariaLabel });
  }, [ariaLabel, readOnly]);

  // Re-measured when the palette changes. Monaco holds themes by name, so redefining restyles every
  // open editor at once.
  useEffect(() => {
    if (instance.current === undefined) return;
    monaco.editor.defineTheme(MONACO_THEME_ID, buildMonacoTheme());
    monaco.editor.setTheme(MONACO_THEME_ID);
  }, [themeKey]);

  /*
   * The value, when it was changed by something other than typing.
   *
   * Guarded on inequality, because writing the value Monaco already has resets the caret to the top
   * of the file — which is what happens on every keystroke otherwise.
   */
  useEffect(() => {
    const editor = instance.current;
    if (editor === undefined) return;
    if (editor.getValue() === value) return;
    editor.executeEdits('external', [
      { range: editor.getModel()!.getFullModelRange(), text: value, forceMoveMarkers: true },
    ]);
  }, [value]);

  useEffect(() => {
    const editor = instance.current;
    const model = editor?.getModel();
    if (model === null || model === undefined) return;

    monaco.editor.setModelMarkers(
      model,
      'nos',
      (markers ?? []).map((marker) => ({
        startLineNumber: marker.line,
        startColumn: marker.column ?? 1,
        endLineNumber: marker.endLine ?? marker.line,
        // To the end of the line when no column is given: a compiler that reports only a line means
        // "somewhere here", and a one-character squiggle claims a precision it did not have.
        endColumn: marker.endColumn ?? model.getLineMaxColumn(Math.min(marker.line, model.getLineCount())),
        message: marker.message,
        severity:
          marker.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : marker.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      })),
    );
  }, [markers]);

  /*
   * No `aria-label` on the host.
   *
   * Monaco puts the name on its own hidden textarea — the element that actually takes focus and that
   * a screen reader reads. Naming the wrapper as well would give the same label to two elements, and
   * anything looking one up by name would have to guess which; the harness did exactly that and got
   * the container, which cannot be typed into.
   */
  return <div ref={host} data-code-editor={path} className={className} />;
}

/** The Monaco namespace, for callers registering their own language features. */
export { monaco };
