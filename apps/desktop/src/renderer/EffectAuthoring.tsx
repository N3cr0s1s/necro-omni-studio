import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { FileCode2Icon, PlusIcon, SaveIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import type { CompileCheck } from '@nos/compositor';
import {
  type EffectDraft,
  type EffectParamDraft,
  EFFECT_PARAM_TYPES,
  draftFromEffect,
  effectDraftHasErrors,
  effectFiles,
  effectManifestJson,
  emptyEffectDraft,
  validateEffectDraft,
} from '@nos/effects';
import type { AnyEffectManifest } from '@nos/effects';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import { Field, FieldLabel } from '@nos/ui/components/ui/field';
import { Input } from '@nos/ui/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@nos/ui/components/ui/native-select';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';
import { Separator } from '@nos/ui/components/ui/separator';
import { Spinner } from '@nos/ui/components/ui/spinner';
import { bridge } from './bridge.js';
import { EFFECTS_FOLDER } from './use-effect-library.js';
import { ShaderPreview } from './ShaderPreview.js';
import { type CodeMarker, LazyCodeEditor } from './code-editor/LazyCodeEditor.js';
import { useMonacoTheme } from './code-editor/use-monaco-theme.js';

/**
 * Writing an effect: the GLSL, what it exposes, and what it looks like — on one screen.
 *
 * Issue #28. §6.3 has always defined an effect as a fragment shader plus a manifest and §4 has always
 * reserved `effects/` for both, so the *format* was reachable and the **authoring** was not: a text
 * editor, a guess at the schema, a reload, and a drag onto a clip to find out whether it compiled.
 *
 * ## Why the three panes are these three
 *
 * The shader is the work. The preview is the feedback loop, and without it the cycle is long enough
 * that people stop making small changes — which is how shaders are actually written. The manifest side
 * is small because it is small: an id, a name, and the parameters, which are the only part that has to
 * agree with the shader and is therefore where the editor earns its keep by saying so.
 *
 * ## Saving writes both files
 *
 * `<id>.json` and `<id>.frag`, named by `effectFiles` so nothing has to remember the pairing. The
 * shader goes first: a manifest naming a shader that is not there is a *broken* effect in the
 * registry, while a shader with no manifest is simply a file nobody reads. If the second write fails,
 * the worse of the two states is the one that did not happen.
 */

export interface EffectAuthoringProps {
  /** Effects already in the project, so saving cannot silently replace one. */
  readonly existing?: readonly { readonly manifest: AnyEffectManifest; readonly shader: string }[];
  /** The effect to open for editing, by id. Absent starts a new one. */
  readonly editing?: string;
  readonly onClose: () => void;
  /**
   * Reports the name as it is typed, so the tab holding this follows it.
   *
   * The screen does not own its own title any more — issue #31 made it a tab, and a bar of three
   * unsaved effects all called "New effect" is unusable.
   */
  readonly onTitle?: (title: string) => void;
  /** Reloads the library, so a saved effect is usable without a restart. */
  readonly onSaved: () => void;
}

export function EffectAuthoring({
  existing,
  editing,
  onClose,
  onTitle,
  onSaved,
}: EffectAuthoringProps): ReactNode {
  const opened = useMemo(
    () => existing?.find((entry) => (entry.manifest.id as string) === editing),
    [existing, editing],
  );

  const [draft, setDraft] = useState<EffectDraft>(() =>
    opened === undefined ? emptyEffectDraft() : draftFromEffect(opened.manifest, opened.shader),
  );
  const [compile, setCompile] = useState<CompileCheck>({ ok: true });
  const themeKey = useMonacoTheme();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const issues = useMemo(() => validateEffectDraft(draft), [draft]);
  const taken = useMemo(
    () => new Set((existing ?? []).map((entry) => entry.manifest.id as string)),
    [existing],
  );
  const replaces = draft.id !== editing && taken.has(draft.id) ? draft.id : undefined;

  /*
   * Save is gated on the contract *and* on the compile.
   *
   * Either alone is not enough. A draft that satisfies the schema and does not compile is an effect
   * that appears in the menu and breaks the frame it is dropped on; one that compiles but has a
   * duplicate uniform is a control that silently does nothing. Both are things the editor can see
   * before the file exists, so neither should be discovered afterwards.
   */
  const blocked = effectDraftHasErrors(draft) || !compile.ok;

  const save = useCallback(async () => {
    const api = bridge();
    if (api === undefined) {
      setError('the desktop bridge is unavailable, so nothing can be written');
      return;
    }

    setSaving(true);
    try {
      const files = effectFiles(draft.id);
      // The shader first. A manifest naming a shader that is not there is a broken effect in the
      // registry; a shader nothing names is a file nobody reads.
      await api.writeTextFile(`${EFFECTS_FOLDER}/${files.shader}`, draft.shader);
      await api.writeTextFile(
        `${EFFECTS_FOLDER}/${files.manifest}`,
        `${JSON.stringify(effectManifestJson(draft), null, 2)}\n`,
      );
      onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, [draft, onClose, onSaved]);

  return (
    <section
      aria-label="Effect editor"
      // A panel filling its tab, not an overlay. It covered the window and the only way back to the
      // timeline was to close it, which is the wrong shape for something written *while* looking at
      // the clip it is for — issue #31.
      className="bg-background flex min-h-0 flex-1 flex-col"
    >
      <header className="flex h-11 flex-none items-center gap-3 px-4">
        <FileCode2Icon className="text-muted-foreground size-3.5" />
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {editing === undefined ? 'New effect' : `Editing ${editing}`}
        </span>

        {replaces !== undefined && (
          <p className="text-destructive flex items-center gap-1.5 font-mono text-xs">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            {`saving replaces the ${replaces} effect`}
          </p>
        )}
        {error !== undefined && (
          <p className="text-destructive flex items-center gap-1.5 font-mono text-xs">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            {error}
          </p>
        )}

        <Button size="sm" disabled={blocked || saving} onClick={() => void save()} className="ml-auto">
          {saving ? <Spinner className="size-3.5" /> : <SaveIcon />}
          Save effect
        </Button>
      </header>
      <Separator />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Fragment shader
          </span>
          {/*
            Issue #35: VS Code's editor here too, with GLSL colouring this codebase defines — Monaco
            ships none, and `cpp` gets `float` right while missing `vec3` and `sampler2D`, which is
            worse than plain text because the eye learns to trust it.

            The compiler's own diagnostics are underlined where they happened. They were already
            reported as a line and a message under the pane, which meant reading a number and then
            counting rows to find it — the one job an editor should never leave to the reader.
          */}
          <LazyCodeEditor
            value={draft.shader}
            onChange={(shader) => setDraft((current) => ({ ...current, shader }))}
            language="glsl"
            // Named after the file it will be saved as, so the undo history follows the effect rather
            // than the dialog being open.
            path={`${EFFECTS_FOLDER}/${draft.id === '' ? 'untitled' : draft.id}.frag`}
            markers={compileMarkers(compile)}
            themeKey={themeKey}
            ariaLabel="Fragment shader"
            className="min-h-0 flex-1"
          />
        </div>

        <Separator orientation="vertical" />

        <ScrollArea className="w-96 flex-none">
          <div className="flex flex-col gap-4 p-4">
            <ShaderPreview draft={draft} onCompile={setCompile} />

            <Separator />

            <Identity draft={draft} onChange={setDraft} {...(onTitle !== undefined ? { onTitle } : {})} />

            <Separator />

            <Params draft={draft} onChange={setDraft} />

            {issues.length > 0 && (
              <>
                <Separator />
                <div className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Problems
                  </span>
                  {issues.map((issue) => (
                    <p
                      key={`${issue.path}:${issue.message}`}
                      className="flex items-start gap-2 font-mono text-xs"
                    >
                      <Badge
                        variant={issue.severity === 'error' ? 'destructive' : 'outline'}
                        className="shrink-0"
                      >
                        {issue.severity}
                      </Badge>
                      <span className="text-muted-foreground">{issue.path}</span>
                      <span>{issue.message}</span>
                    </p>
                  ))}
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </section>
  );
}

/** What the effect is called and where it appears. */
function Identity({
  draft,
  onChange,
  onTitle,
}: {
  readonly draft: EffectDraft;
  readonly onChange: (update: (current: EffectDraft) => EffectDraft) => void;
  /** Reported as the name is typed, so the tab holding this screen follows it. */
  readonly onTitle?: (title: string) => void;
}): ReactNode {
  const set = (patch: Partial<EffectDraft>): void => onChange((current) => ({ ...current, ...patch }));

  return (
    <div className="grid grid-cols-2 items-end gap-3">
      <Labelled label="Id">
        {(id) => (
          <Input
            id={id}
            // The id is two filenames and the value in `EffectInstance.effect`, which is why the draft
            // refuses anything that would need escaping in either.
            placeholder="film_grain"
            value={draft.id}
            onChange={(event) => set({ id: event.target.value })}
          />
        )}
      </Labelled>
      <Labelled label="Name">
        {(id) => (
          <Input
            id={id}
            placeholder="Film grain"
            value={draft.name}
            onChange={(event) => {
              set({ name: event.target.value });
              onTitle?.(event.target.value);
            }}
          />
        )}
      </Labelled>
      <Labelled label="Kind">
        {(id) => (
          <NativeSelect
            id={id}
            className="w-full"
            value={draft.category}
            onChange={(event) => {
              const category = event.target.value === 'transition' ? 'transition' : 'effect';
              // The samplers follow the kind, because they are what the compositor binds: an effect
              // reads the frame so far, a transition reads the two it blends. Left alone, switching
              // kind produced a transition that reads `source`, which compiles and renders nothing.
              set({
                category,
                samplers: category === 'transition' ? ['from', 'to'] : ['source'],
              });
            }}
          >
            <NativeSelectOption value="effect">effect</NativeSelectOption>
            <NativeSelectOption value="transition">transition</NativeSelectOption>
          </NativeSelect>
        )}
      </Labelled>
      <Labelled label="Group">
        {(id) => (
          <Input
            id={id}
            placeholder="where it appears in the menu"
            value={draft.group ?? ''}
            // Cleared by dropping the key, never by writing `undefined`: under
            // `exactOptionalPropertyTypes` those are different types, and the second reaches the file
            // as `null`, which the schema rejects on the way back in.
            onChange={(event) => onChange((current) => withGroup(current, event.target.value))}
          />
        )}
      </Labelled>
    </div>
  );
}

/** The controls the effect offers, each of which is a uniform the shader has to read. */
function Params({
  draft,
  onChange,
}: {
  readonly draft: EffectDraft;
  readonly onChange: (update: (current: EffectDraft) => EffectDraft) => void;
}): ReactNode {
  const edit = (id: string, patch: Partial<EffectParamDraft>): void =>
    onChange((current) => ({
      ...current,
      params: current.params.map((param) => (param.id === id ? { ...param, ...patch } : param)),
    }));

  /** For a change that has to *remove* a field, which a patch cannot express. */
  const replace = (id: string, next: EffectParamDraft): void =>
    onChange((current) => ({
      ...current,
      params: current.params.map((param) => (param.id === id ? next : param)),
    }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Parameters</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() =>
            onChange((current) => ({
              ...current,
              params: [
                ...current.params,
                {
                  // Numbered from the length, and the id is never written to the file — it exists so a
                  // row keeps its identity while its key is being typed.
                  id: `param_${current.params.length + 1}_${Date.now()}`,
                  key: `param_${current.params.length + 1}`,
                  uniform: '',
                  type: 'float',
                },
              ],
            }))
          }
        >
          <PlusIcon />
          Add parameter
        </Button>
      </div>

      {draft.params.length === 0 ? (
        <p className="text-muted-foreground font-mono text-xs">
          none — the effect renders the same way every time
        </p>
      ) : (
        draft.params.map((param) => (
          <div key={param.id} className="bg-muted/50 flex flex-col gap-3 rounded-md border p-3">
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
              <Labelled label="Key">
                {(id) => (
                  <Input
                    id={id}
                    value={param.key}
                    onChange={(event) => edit(param.id, { key: event.target.value })}
                  />
                )}
              </Labelled>
              <Labelled label="Type">
                {(id) => (
                  <NativeSelect
                    id={id}
                    className="w-full"
                    value={param.type}
                    onChange={(event) =>
                      edit(param.id, { type: event.target.value as EffectParamDraft['type'] })
                    }
                  >
                    {EFFECT_PARAM_TYPES.map((entry) => (
                      <NativeSelectOption key={entry.type} value={entry.type}>
                        {/* Said here rather than in a footnote: whether a parameter can be keyframed
                            is usually why one type is chosen over another. */}
                        {entry.keyframable ? `${entry.type} · keyframable` : entry.type}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </Labelled>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${param.key}`}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    params: current.params.filter((entry) => entry.id !== param.id),
                  }))
                }
              >
                <Trash2Icon />
              </Button>
            </div>

            <div className="grid grid-cols-3 items-end gap-3">
              <Labelled label="Uniform">
                {(id) => (
                  <Input
                    id={id}
                    // Blank means "same as the key", which is the common case and stays out of the file.
                    placeholder={param.key}
                    value={param.uniform}
                    onChange={(event) => edit(param.id, { uniform: event.target.value })}
                  />
                )}
              </Labelled>
              <Labelled label="Min">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    value={param.min ?? ''}
                    onChange={(event) => replace(param.id, withBound(param, 'min', event.target.value))}
                  />
                )}
              </Labelled>
              <Labelled label="Max">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    value={param.max ?? ''}
                    onChange={(event) => replace(param.id, withBound(param, 'max', event.target.value))}
                  />
                )}
              </Labelled>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * A draft with its group set, or without one when the field is cleared.
 *
 * The key is dropped rather than set to `undefined`: `exactOptionalPropertyTypes` makes those different
 * types, and the second reaches the file as `null`, which the schema rejects — so the editor would
 * write an effect it could not reopen.
 */
function withGroup(draft: EffectDraft, group: string): EffectDraft {
  const { group: _dropped, ...rest } = draft;
  return group === '' ? rest : { ...rest, group };
}

/** The same, for a range bound a user has emptied. */
function withBound(param: EffectParamDraft, bound: 'min' | 'max', raw: string): EffectParamDraft {
  const { [bound]: _dropped, ...rest } = param;
  return raw === '' ? rest : { ...rest, [bound]: Number(raw) };
}

/** A label bound to whatever control the caller renders. The same shape the manifest inspector uses. */
function Labelled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (id: string) => ReactNode;
}): ReactNode {
  const id = `effect-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <Field className="min-w-0 gap-1.5">
      <FieldLabel htmlFor={id} className="text-xs">
        {label}
      </FieldLabel>
      {children(id)}
    </Field>
  );
}

/**
 * Compiler diagnostics as editor markers.
 *
 * The lines are already in *authored* coordinates — `assembleFragmentShader` reports how many lines
 * the wrapper added and `checkShader` subtracts them — so they land where the author is looking
 * rather than in generated preamble they cannot see.
 *
 * A diagnostic at or before line zero came from the preamble itself, which the author did not write.
 * Those are pinned to the first line rather than dropped: something is wrong with the shader and
 * saying so imprecisely beats saying nothing.
 */
export function compileMarkers(check: CompileCheck): readonly CodeMarker[] {
  if (check.ok) return [];

  // A driver that answered with an unstructured log still has something to say, and a pane that
  // showed nothing would look like a shader that compiled.
  if (check.diagnostics.length === 0) {
    return check.log === '' ? [] : [{ line: 1, message: check.log, severity: 'error' as const }];
  }

  return check.diagnostics.map((diagnostic) => ({
    line: Math.max(1, diagnostic.line),
    ...(diagnostic.column !== undefined ? { column: diagnostic.column } : {}),
    message: diagnostic.message,
    severity: diagnostic.severity,
  }));
}
