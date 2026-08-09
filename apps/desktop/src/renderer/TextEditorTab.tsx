import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { SaveIcon, TriangleAlertIcon } from 'lucide-react';
import { jsonProblem } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { Separator } from '@nos/ui/components/ui/separator';
import { Spinner } from '@nos/ui/components/ui/spinner';
import { bridge } from './bridge.js';
import { LazyCodeEditor } from './code-editor/LazyCodeEditor.js';
import { useMonacoTheme } from './code-editor/use-monaco-theme.js';

/**
 * A project file, open for editing.
 *
 * Issue #31 asked for it and #32 said why: double-clicking a `.json` reported that it could not go on
 * the timeline, which is true and leaves the user nowhere. A project *is* a folder, and the files in
 * it that are not media are manifests and notes — the things you most want to nudge by hand.
 *
 * ## Highlighting without a library
 *
 * The renderer runs under a CSP that forbids fetching anything, so an editor library would have to be
 * vendored. What is actually needed is JSON colouring, which is a tokenizer — written, tested, and
 * kept in `@nos/ui`.
 *
 * ## Completion
 *
 * Issue #31 asked for it "based on a JSON schema". The knowing-what-goes-where part lives in
 * `@nos/core` and the descriptions of the manifests live beside the types they describe; this file
 * only turns a caret into a position on screen and a keypress into a command. That split is what lets
 * the hard parts — a caret inside quotes, a key already written further down — be tested without
 * rendering anything.
 *
 * The technique is a highlighted layer *under* a transparent textarea, aligned character for
 * character. Editing therefore stays a real textarea: selection, undo, IME, spellcheck and the caret
 * are the platform's rather than reimplemented, which is where hand-rolled editors go wrong. It also
 * means the tokenizer must cover every character of the input — whitespace included — or the two
 * layers drift.
 */

export interface TextEditorTabProps {
  /** Project-relative path, which is also the tab's subject. */
  readonly path: string;
  /** Reports unsaved state, so the tab can mark itself. */
  readonly onDirty?: (dirty: boolean) => void;
  /** Reloads whatever reads this file, so saving a manifest takes effect without a restart. */
  readonly onSaved?: (path: string) => void;
}

export function TextEditorTab({ path, onDirty, onSaved }: TextEditorTabProps): ReactNode {
  const [loaded, setLoaded] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const api = bridge();
    if (api === undefined) {
      setError('the desktop bridge is unavailable, so nothing can be read');
      return;
    }

    let cancelled = false;
    void api
      .readTextFile(path)
      .then((contents) => {
        if (cancelled) return;
        // An unreadable file opens *empty and marked*, rather than opening blank as though it were
        // empty — saving over a file you could not read is the one outcome worth preventing here.
        if (contents === undefined) setError(`${path} could not be read`);
        else {
          setLoaded(contents);
          setText(contents);
        }
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));

    return () => {
      cancelled = true;
    };
  }, [path]);

  const dirty = loaded !== undefined && text !== loaded;
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);

  const isJson = path.toLowerCase().endsWith('.json');
  // Registered globally rather than per editor, so the completions know which description applies
  // without this component telling Monaco anything.
  const themeKey = useMonacoTheme();
  const problem = useMemo(() => (isJson ? jsonProblem(text) : undefined), [isJson, text]);

  const save = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;

    setSaving(true);
    try {
      await api.writeTextFile(path, text);
      setLoaded(text);
      onSaved?.(path);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, [onSaved, path, text]);

  return (
    <section aria-label="File editor" className="bg-background flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 flex-none items-center gap-3 px-4">
        <span className="text-muted-foreground font-mono text-xs">{path}</span>
        {dirty && <span className="text-muted-foreground font-mono text-xs">· unsaved</span>}

        {problem !== undefined && (
          <p className="text-destructive flex items-center gap-1.5 font-mono text-xs">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            {/* The line where it stopped parsing, when the engine said — a message with no position is
                a search through the file. */}
            {problem.line === undefined ? problem.message : `line ${problem.line}: ${problem.message}`}
          </p>
        )}
        {error !== undefined && (
          <p className="text-destructive flex items-center gap-1.5 font-mono text-xs">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            {error}
          </p>
        )}

        <Button
          size="sm"
          className="ml-auto"
          // Saving invalid JSON over a manifest is how a project stops loading. The editor can see it
          // before the file exists, so it refuses rather than reporting it afterwards.
          disabled={!dirty || saving || problem !== undefined || loaded === undefined}
          onClick={() => void save()}
        >
          {saving ? <Spinner className="size-3.5" /> : <SaveIcon />}
          Save
        </Button>
      </header>
      <Separator />

      {/* No padding and no scroller of its own: Monaco owns its scrolling, and a parent that also
          scrolled would move the text out from under the caret. */}
      <div className="min-h-0 flex-1">
        <LazyCodeEditor
          value={text}
          onChange={setText}
          language={languageFor(path)}
          path={path}
          themeKey={themeKey}
          // The parse failure, underlined where it is. It was already reported as a line in the
          // header, which means reading a number and then counting rows — the one job an editor
          // should never leave to the reader.
          markers={
            problem?.line === undefined
              ? []
              : [
                  {
                    line: problem.line,
                    ...(problem.column !== undefined ? { column: problem.column } : {}),
                    message: problem.message,
                    severity: 'error' as const,
                  },
                ]
          }
          ariaLabel="File contents"
          className="size-full"
        />
      </div>
    </section>
  );
}

/**
 * Which language a file is edited as.
 *
 * By extension, which is the same rule the schema registry uses. `plaintext` for everything else
 * rather than a guess: a note coloured as if it were code is harder to read than one left alone.
 */
export function languageFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.frag') || lower.endsWith('.vert') || lower.endsWith('.glsl')) return 'glsl';
  return 'plaintext';
}
