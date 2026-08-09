import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SaveIcon, TriangleAlertIcon } from 'lucide-react';
import { jsonProblem, tokenizeJson } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { Separator } from '@nos/ui/components/ui/separator';
import { Spinner } from '@nos/ui/components/ui/spinner';
import { cn } from '@nos/ui/lib/utils';
import { bridge } from './bridge.js';

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

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Highlighted text={text} json={isJson} onChange={setText} />
      </div>
    </section>
  );
}

/**
 * The editable surface: a transparent textarea over a coloured copy of the same text.
 *
 * Both layers use identical type metrics and identical padding, and the tokenizer covers every
 * character — that is what keeps the caret over the glyph it belongs to. A trailing newline gets an
 * extra blank line in the coloured layer, because a `<pre>` collapses the last one and the two would
 * otherwise disagree by a row at the bottom of every file.
 */
function Highlighted({
  text,
  json,
  onChange,
}: {
  readonly text: string;
  readonly json: boolean;
  readonly onChange: (text: string) => void;
}): ReactNode {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const tokens = useMemo(() => (json ? tokenizeJson(text) : []), [json, text]);

  const shared = 'font-mono text-xs leading-5 whitespace-pre-wrap break-words';

  return (
    <div className="relative min-h-full">
      <pre aria-hidden="true" className={cn(shared, 'text-foreground m-0 p-0')}>
        {json
          ? tokens.map((token, index) => (
              <span key={index} className={toneOf(token.kind)}>
                {token.text}
              </span>
            ))
          : text}
        {/* `<pre>` swallows a single trailing newline; without this the two layers differ by a row. */}
        {text.endsWith('\n') ? '\n' : ''}
      </pre>

      <textarea
        ref={areaRef}
        aria-label="File contents"
        spellCheck={false}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        // Transparent text over the coloured copy, with a visible caret. `resize-none` because the
        // container scrolls; a textarea that grew its own scrollbar would scroll independently of the
        // layer beneath it.
        className={cn(
          shared,
          'caret-foreground absolute inset-0 m-0 resize-none border-0 bg-transparent p-0 text-transparent outline-none',
        )}
      />
    </div>
  );
}

/**
 * How a token is drawn.
 *
 * **Emphasis, not hue**, and that is a measured decision rather than a stylistic one. Highlighting
 * wants a categorical palette, and shadcn's is `chart-1`…`chart-5` — which this application already
 * forbids as text, because across the six shipped themes those roles run to **1.42:1** against the
 * surface they sit on. Code is the smallest text in the window, so it is the worst place for them.
 *
 * `primary` was the other candidate and fails too: 17:1 in five themes and **2.49:1** in the one the
 * editor opens in. Measured against `background` in every theme, only `foreground` and
 * `muted-foreground` clear AA everywhere (4.73–7.75), and `destructive` is spoken for — it means an
 * error, and a number drawn in it would say something false.
 *
 * Two tones and a weight is less than a themed editor gives, and it is what this palette can honestly
 * carry. It still does the job JSON needs: keys are what you scan for, values are what you read, and
 * punctuation is structure you should be able to look past.
 */
function toneOf(kind: string): string {
  switch (kind) {
    case 'key':
      return 'text-foreground font-medium';
    case 'string':
      return 'text-foreground';
    case 'number':
    case 'keyword':
      return 'text-muted-foreground';
    case 'punctuation':
      return 'text-muted-foreground/70';
    default:
      return '';
  }
}
