import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { FileJsonIcon, PlusIcon, SaveIcon, SearchIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import {
  type AlsoBinding,
  type DraftIssue,
  type DraftParam,
  type DraftParamChanges,
  type GeneratorParamType,
  type GraphLiteral,
  type ManifestDraft,
  type ParamField,
  DERIVED_DEFAULTS,
  PARAM_TYPES,
  TEXT_SOURCES,
  capabilitySource,
  choiceMode,
  choicesAsText,
  draftHasErrors,
  draftManifestJson,
  editConsumes,
  missingConsumes,
  removeConsumes,
  defaultAsText,
  defaultControl,
  hasField,
  optionsForMode,
  parseChoices,
  parseDefault,
  suggestedConsumes,
  toCapabilityOptions,
  unmatchedConsumes,
  validateDraft,
} from '@nos/generators';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import { Checkbox } from '@nos/ui/components/ui/checkbox';
import { Field, FieldLabel } from '@nos/ui/components/ui/field';
import { Label } from '@nos/ui/components/ui/label';
import { Input } from '@nos/ui/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@nos/ui/components/ui/input-group';
import { Item, ItemContent, ItemGroup, ItemMedia } from '@nos/ui/components/ui/item';
import { NativeSelect, NativeSelectOption } from '@nos/ui/components/ui/native-select';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';
import { Separator } from '@nos/ui/components/ui/separator';
import { cn } from '@nos/ui/lib/utils';

/**
 * The manifest inspector (spec §5.9).
 *
 * "A manifestet nem kézzel írjuk" — the manifest is not written by hand. This loads a graph's literal
 * inputs, lets the user tick which become parameters and give each a type and a range, and writes the
 * manifest out. **No code is written**, which is the entire point: adding a generative capability must
 * never require a developer.
 *
 * Two properties this component exists to hold:
 *
 * - It shows **only** what the graph actually contains. Connections are absent because binding to one
 *   would patch a value the graph immediately overwrites.
 * - It never blocks saving a manifest whose graph is not connected. The spec writes contracts first — the
 *   registry has an `unbound` status precisely for that — so unbound state is a warning, not an error.
 */

export interface ManifestInspectorProps {
  readonly draft: ManifestDraft;
  /** Literals discovered in the loaded graph. Empty before a graph is chosen. */
  readonly literals: readonly GraphLiteral[];
  /** Node ids the graph contains, for declaring outputs. */
  readonly nodeIds?: readonly string[];
  readonly onChange?: ((draft: ManifestDraft) => void) | undefined;
  readonly onPromote?: ((literal: GraphLiteral) => void) | undefined;
  readonly onDemote?: ((id: string) => void) | undefined;
  readonly onEditParam?: ((id: string, changes: DraftParamChanges) => void) | undefined;
  readonly onSave?: (() => void) | undefined;
}

export function ManifestInspector({
  draft,
  literals,
  nodeIds,
  onChange,
  onPromote,
  onDemote,
  onEditParam,
  onSave,
}: ManifestInspectorProps): ReactNode {
  const [filter, setFilter] = useState('');
  const issues = useMemo(() => validateDraft(draft), [draft]);
  const blocked = draftHasErrors(draft);
  const promoted = useMemo(
    () => new Map(draft.params.map((param) => [param.pointer, param])),
    [draft.params],
  );

  const groups = useMemo(() => groupByNode(literals, filter), [literals, filter]);

  return (
    <section aria-label="Manifest inspector" className="flex h-full flex-col">
      <div className="flex h-9 flex-none items-center gap-3 px-4">
        <FileJsonIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Manifest inspector
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={blocked ? 'destructive' : draft.graph === null ? 'outline' : 'secondary'}>
            {blocked ? 'incomplete' : draft.graph === null ? 'unbound' : 'ready'}
          </Badge>
          <Button
            size="sm"
            disabled={blocked}
            onClick={onSave}
            title={blocked ? 'Fix the errors below first' : 'Write the manifest'}
          >
            <SaveIcon />
            Save manifest
          </Button>
        </div>
      </div>
      <Separator />

      <div className="flex min-h-0 flex-1">
        <GraphColumn
          groups={groups}
          promoted={promoted}
          filter={filter}
          onFilter={setFilter}
          {...(onPromote !== undefined ? { onPromote } : {})}
          {...(onDemote !== undefined ? { onDemote } : {})}
        />
        <DraftColumn
          draft={draft}
          nodeIds={nodeIds ?? []}
          issues={issues}
          {...(onChange !== undefined ? { onChange } : {})}
          {...(onEditParam !== undefined ? { onEditParam } : {})}
        />
      </div>
    </section>
  );
}

interface LiteralGroup {
  readonly nodeId: string;
  readonly nodeClass: string;
  readonly literals: readonly GraphLiteral[];
}

/**
 * Literals grouped by node.
 *
 * Grouped because a graph has hundreds of inputs and the user thinks in nodes — "the sampler's steps", not
 * "the input named steps". A flat list of three hundred rows is unusable at exactly the moment this
 * component matters.
 */
function groupByNode(literals: readonly GraphLiteral[], filter: string): readonly LiteralGroup[] {
  const needle = filter.trim().toLowerCase();
  const groups = new Map<string, GraphLiteral[]>();

  for (const literal of literals) {
    if (needle !== '' && !matchesFilter(literal, needle)) continue;
    const existing = groups.get(literal.nodeId);
    if (existing === undefined) groups.set(literal.nodeId, [literal]);
    else existing.push(literal);
  }

  return [...groups.entries()].map(([nodeId, entries]) => ({
    nodeId,
    nodeClass: entries[0]?.nodeClass ?? 'unknown',
    literals: entries,
  }));
}

function matchesFilter(literal: GraphLiteral, needle: string): boolean {
  return (
    literal.input.toLowerCase().includes(needle) ||
    literal.nodeClass.toLowerCase().includes(needle) ||
    literal.nodeId.toLowerCase().includes(needle) ||
    String(literal.value).toLowerCase().includes(needle)
  );
}

function GraphColumn({
  groups,
  promoted,
  filter,
  onFilter,
  onPromote,
  onDemote,
}: {
  readonly groups: readonly LiteralGroup[];
  readonly promoted: ReadonlyMap<string, DraftParam>;
  readonly filter: string;
  readonly onFilter: (value: string) => void;
  readonly onPromote?: (literal: GraphLiteral) => void;
  readonly onDemote?: (id: string) => void;
}): ReactNode {
  return (
    <div className="flex w-95 min-h-0 flex-none flex-col border-r">
      <div className="p-3">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Filter graph inputs"
            placeholder="Filter by node, input or value"
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
          />
        </InputGroup>
      </div>
      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {groups.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">
              no graph inputs — load a graph, or clear the filter
            </p>
          )}
          {groups.map((group) => (
            <div key={group.nodeId} className="mb-4">
              <div className="flex items-center gap-2 p-2">
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group.nodeClass}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{group.nodeId}</span>
              </div>

              <ItemGroup className="gap-0.5">
                {group.literals.map((literal) => (
                  <LiteralRow
                    key={literal.pointer}
                    literal={literal}
                    param={promoted.get(literal.pointer)}
                    {...(onPromote !== undefined ? { onPromote } : {})}
                    {...(onDemote !== undefined ? { onDemote } : {})}
                  />
                ))}
              </ItemGroup>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/** One graph literal, with the tick that promotes it to a parameter. */
function LiteralRow({
  literal,
  param,
  onPromote,
  onDemote,
}: {
  readonly literal: GraphLiteral;
  readonly param: DraftParam | undefined;
  readonly onPromote?: (literal: GraphLiteral) => void;
  readonly onDemote?: (id: string) => void;
}): ReactNode {
  const ticked = param !== undefined;
  const id = useId();

  return (
    <Item size="xs" className={cn('py-1', ticked && 'bg-chart-4/10')}>
      <ItemMedia>
        <Checkbox
          id={id}
          checked={ticked}
          aria-label={`${literal.input} on ${literal.nodeClass} ${literal.nodeId}`}
          onCheckedChange={() => {
            if (param !== undefined) onDemote?.(param.id);
            else onPromote?.(literal);
          }}
        />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm">
          {literal.input}
        </label>
      </ItemContent>
      <span className="max-w-35 truncate font-mono text-xs text-muted-foreground">
        {String(literal.value)}
      </span>
    </Item>
  );
}

function DraftColumn({
  draft,
  nodeIds,
  issues,
  onChange,
  onEditParam,
}: {
  readonly draft: ManifestDraft;
  readonly nodeIds: readonly string[];
  readonly issues: readonly DraftIssue[];
  readonly onChange?: (draft: ManifestDraft) => void;
  readonly onEditParam?: (id: string, changes: DraftParamChanges) => void;
}): ReactNode {
  return (
    <ScrollArea className="min-w-0 flex-1">
      <div className="flex flex-col gap-5 p-4">
        <Identity draft={draft} {...(onChange !== undefined ? { onChange } : {})} />

        <div className="flex flex-col gap-3">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Parameters
          </span>
          {draft.params.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">
              tick a graph input on the left to make it a parameter
            </p>
          )}
          {draft.params.map((param) => (
            <ParamRow
              key={param.id}
              param={param}
              {...(onEditParam !== undefined ? { onEdit: onEditParam } : {})}
            />
          ))}
        </div>

        <Consumes draft={draft} {...(onChange !== undefined ? { onChange } : {})} />
        <Separator />
        <Outputs draft={draft} nodeIds={nodeIds} {...(onChange !== undefined ? { onChange } : {})} />
        <Issues issues={issues} />
        <Preview draft={draft} />
      </div>
    </ScrollArea>
  );
}

/**
 * A labelled control.
 *
 * Plumbing, not a component: it pairs the registry's `Field` and `FieldLabel` with a generated id so the
 * label is *associated* with its control rather than merely sitting above it. Without the association a
 * click on the label does nothing and a screen reader reads the control unnamed — and there are eighteen
 * of them on this screen.
 */
function Labelled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (id: string) => ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <Field className="min-w-0 gap-1.5">
      <FieldLabel htmlFor={id} className="text-xs">
        {label}
      </FieldLabel>
      {children(id)}
    </Field>
  );
}

function Identity({
  draft,
  onChange,
}: {
  readonly draft: ManifestDraft;
  readonly onChange?: (draft: ManifestDraft) => void;
}): ReactNode {
  const set = (changes: Partial<ManifestDraft>): void => onChange?.({ ...draft, ...changes });

  return (
    <div className="grid grid-cols-3 gap-3">
      <Labelled label="Id">
        {(id) => <Input id={id} value={draft.id} onChange={(event) => set({ id: event.target.value })} />}
      </Labelled>
      <Labelled label="Name">
        {(id) => <Input id={id} value={draft.name} onChange={(event) => set({ name: event.target.value })} />}
      </Labelled>
      <Labelled label="Backend">
        {(id) => (
          <Input id={id} value={draft.backend} onChange={(event) => set({ backend: event.target.value })} />
        )}
      </Labelled>
      <Labelled label="Produces">
        {(id) => (
          <NativeSelect
            id={id}
            className="w-full"
            value={draft.produces}
            onChange={(event) => set({ produces: event.target.value as ManifestDraft['produces'] })}
          >
            {['video', 'audio', 'image', 'text'].map((type) => (
              <NativeSelectOption key={type} value={type}>
                {type}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </Labelled>
      <Labelled label="Length">
        {(id) => (
          <NativeSelect
            id={id}
            className="w-full"
            value={draft.duration}
            onChange={(event) => set({ duration: event.target.value as ManifestDraft['duration'] })}
          >
            <NativeSelectOption value="declared">declared — a parameter sets it</NativeSelectOption>
            <NativeSelectOption value="discovered">discovered — only the output says</NativeSelectOption>
          </NativeSelect>
        )}
      </Labelled>
      {/* Only for a declared length: on a discovered one there is no parameter to name, and offering
          the control would suggest the length could be pinned when only the output reveals it. */}
      {draft.duration === 'declared' && (
        <Labelled label="Length from">
          {(id) => (
            <NativeSelect
              id={id}
              className="w-full"
              value={draft.durationFrom?.param ?? ''}
              onChange={(event) => {
                if (event.target.value === '') {
                  // Removed rather than set to `undefined`: an optional field that is present and
                  // undefined is a different thing from an absent one, and the manifest writer
                  // distinguishes them.
                  const { durationFrom: _cleared, ...rest } = draft;
                  onChange?.(rest);
                  return;
                }
                set({
                  durationFrom: {
                    param: event.target.value,
                    unit: draft.durationFrom?.unit ?? 'seconds',
                  },
                });
              }}
            >
              {/* Naming nothing is legitimate — a key-convention fallback covers the common names —
                  but it has to say what it falls back to, or a manifest whose length parameter is
                  called something else sizes every placeholder from the default. */}
              <NativeSelectOption value="">by key convention</NativeSelectOption>
              {draft.params
                .filter((param) => param.type === 'int' || param.type === 'float')
                .map((param) => (
                  <NativeSelectOption key={param.id} value={param.key}>
                    {param.key}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          )}
        </Labelled>
      )}
      {draft.duration === 'declared' && draft.durationFrom !== undefined && (
        <Labelled label="Length unit">
          {(id) => (
            <NativeSelect
              id={id}
              className="w-full"
              value={draft.durationFrom?.unit ?? 'seconds'}
              onChange={(event) =>
                set({
                  durationFrom: {
                    param: draft.durationFrom?.param ?? '',
                    unit: event.target.value as 'seconds' | 'frames',
                  },
                })
              }
            >
              <NativeSelectOption value="seconds">seconds</NativeSelectOption>
              <NativeSelectOption value="frames">frames</NativeSelectOption>
            </NativeSelect>
          )}
        </Labelled>
      )}
      <Labelled label="Default variants">
        {(id) => (
          <Input
            id={id}
            type="number"
            min={1}
            max={16}
            value={draft.defaultVariants}
            onChange={(event) => set({ defaultVariants: Number(event.target.value) })}
          />
        )}
      </Labelled>
      <Labelled label="Surfaces">
        {(id) => (
          <Input
            id={id}
            value={draft.surfaces.join(', ')}
            placeholder="media_browser, clip_context_menu"
            onChange={(event) => set({ surfaces: parseChoices(event.target.value) })}
          />
        )}
      </Labelled>
      <Labelled label="Requires node classes">
        {(id) => (
          <Input
            id={id}
            value={draft.requires.join(', ')}
            onChange={(event) => set({ requires: parseChoices(event.target.value) })}
          />
        )}
      </Labelled>
      <Labelled label="Graph file">
        {(id) => (
          <Input
            id={id}
            value={draft.graph ?? ''}
            placeholder="not connected yet"
            onChange={(event) => set({ graph: event.target.value === '' ? null : event.target.value })}
          />
        )}
      </Labelled>
    </div>
  );
}

/**
 * One parameter row.
 *
 * Which fields appear is decided by `fieldsFor`, not by conditions written here. That is the fix for
 * how this row came to offer four of the format's ten fields: each was added where it was needed and
 * nobody ever saw the set, so a manifest authored in the application came out with no labels, no
 * defaults, single-line prompt boxes, and — worst — no `transport`, without which an image parameter
 * cannot upload its image.
 *
 * A field still only appears where it means something: a minimum on a boolean, a line-wrapping flag on
 * a number, an upload transport for an integer. A panel that offers meaningless fields teaches the
 * user to ignore all of them.
 */
function ParamRow({
  param,
  onEdit,
}: {
  readonly param: DraftParam;
  readonly onEdit?: (id: string, changes: DraftParamChanges) => void;
}): ReactNode {
  const has = (field: ParamField): boolean => hasField(param.type, field);
  const numeric = has('min');

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/50 p-3">
      <div
        className={cn(
          'grid items-end gap-3',
          numeric ? 'grid-cols-[1.2fr_1fr_1fr_0.6fr_0.6fr_0.6fr]' : 'grid-cols-[1.2fr_1fr_1fr]',
        )}
      >
        <Labelled label={`Key · ${param.pointer === '' ? 'not bound' : param.pointer}`}>
          {(id) => (
            <Input
              id={id}
              value={param.key}
              onChange={(event) => onEdit?.(param.id, { key: event.target.value })}
            />
          )}
        </Labelled>
        <Labelled label="Label">
          {(id) => (
            <Input
              id={id}
              // The name the generate panel shows. Without it the panel shows the raw key, so a
              // manifest authored here read `duration_s` where the shipped ones read `Length`.
              placeholder={param.key}
              value={param.label ?? ''}
              onChange={(event) =>
                onEdit?.(param.id, {
                  label: event.target.value === '' ? undefined : event.target.value,
                })
              }
            />
          )}
        </Labelled>
        <Labelled label="Type">
          {(id) => (
            <NativeSelect
              id={id}
              className="w-full"
              value={param.type}
              onChange={(event) => onEdit?.(param.id, { type: event.target.value as GeneratorParamType })}
            >
              {PARAM_TYPES.map((type) => (
                <NativeSelectOption key={type} value={type}>
                  {type}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Labelled>
        {numeric && (
          <>
            <Labelled label="Min">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  value={param.min ?? ''}
                  onChange={(event) =>
                    onEdit?.(param.id, {
                      min: event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                />
              )}
            </Labelled>
            <Labelled label="Max">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  value={param.max ?? ''}
                  onChange={(event) =>
                    onEdit?.(param.id, {
                      max: event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                />
              )}
            </Labelled>
            <Labelled label="Step">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  value={param.step ?? ''}
                  onChange={(event) =>
                    onEdit?.(param.id, {
                      step: event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                />
              )}
            </Labelled>
          </>
        )}
      </div>
      <ParamBehaviour param={param} {...(onEdit !== undefined ? { onEdit } : {})} />
      {param.type === 'enum' && <ChoiceEditor param={param} {...(onEdit !== undefined ? { onEdit } : {})} />}
      <AlsoBindings param={param} {...(onEdit !== undefined ? { onEdit } : {})} />
    </div>
  );
}

/**
 * Where else this parameter's value has to be written.
 *
 * The spec's `also` mechanism, and its own example is `fps`: it appears as a literal *and* inside a
 * length expression, so a manifest binding only the first leaves the expression stale and delivers a
 * clip of the wrong duration. Both of the project's MiniMax manifests do exactly this.
 *
 * The inspector had no control for it and — worse — dropped it on the way in, so opening one of those
 * manifests and saving it deleted the expression binding silently. The control exists so the field can
 * be authored; carrying it through the draft is what stops it being destroyed.
 */
function AlsoBindings({
  param,
  onEdit,
}: {
  readonly param: DraftParam;
  readonly onEdit?: (id: string, changes: DraftParamChanges) => void;
}): ReactNode {
  const bindings = param.also ?? [];

  const write = (next: readonly AlsoBinding[]): void =>
    onEdit?.(param.id, { also: next.length === 0 ? undefined : next });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {bindings.length === 0 ? 'binds nowhere else' : `also binds to ${bindings.length}`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => write([...bindings, { pointer: '', template: '' }])}
        >
          <PlusIcon />
          Also bind
        </Button>
      </div>

      {bindings.map((binding, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
          <Labelled label="Pointer">
            {(id) => (
              <Input
                id={id}
                value={binding.pointer}
                onChange={(event) =>
                  write(
                    bindings.map((entry, at) =>
                      at === index ? { ...entry, pointer: event.target.value } : entry,
                    ),
                  )
                }
              />
            )}
          </Labelled>
          {/* A template is optional: without one the value is written straight through, which is the
              common case. With one, `{key}` is substituted — that is what keeps an expression that
              mentions the parameter in step with it. */}
          <Labelled label="Template">
            {(id) => (
              <Input
                id={id}
                value={binding.template ?? ''}
                placeholder={`e.g. round(a * {${param.key}})`}
                onChange={(event) =>
                  write(
                    bindings.map((entry, at) =>
                      at === index
                        ? event.target.value === ''
                          ? { pointer: entry.pointer }
                          : { ...entry, template: event.target.value }
                        : entry,
                    ),
                  )
                }
              />
            )}
          </Labelled>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove binding ${index + 1}`}
            onClick={() => write(bindings.filter((_entry, at) => at !== index))}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
    </div>
  );
}

function Outputs({
  draft,
  nodeIds,
  onChange,
}: {
  readonly draft: ManifestDraft;
  readonly nodeIds: readonly string[];
  readonly onChange?: (draft: ManifestDraft) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Outputs</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() =>
            onChange?.({
              ...draft,
              outputs: [
                ...draft.outputs,
                { key: `output_${draft.outputs.length + 1}`, type: draft.produces, node: null },
              ],
            })
          }
        >
          <PlusIcon />
          Add output
        </Button>
      </div>

      {draft.outputs.map((output, index) => (
        <div key={output.key} className="grid grid-cols-2 items-end gap-3">
          <Labelled label="Key">
            {(id) => (
              <Input
                id={id}
                value={output.key}
                onChange={(event) =>
                  onChange?.({
                    ...draft,
                    outputs: draft.outputs.map((entry, position) =>
                      position === index ? { ...entry, key: event.target.value } : entry,
                    ),
                  })
                }
              />
            )}
          </Labelled>
          <Labelled label="Node">
            {(id) => (
              <NativeSelect
                id={id}
                className="w-full"
                value={output.node ?? ''}
                onChange={(event) =>
                  onChange?.({
                    ...draft,
                    outputs: draft.outputs.map((entry, position) =>
                      position === index
                        ? { ...entry, node: event.target.value === '' ? null : event.target.value }
                        : entry,
                    ),
                  })
                }
              >
                <NativeSelectOption value="">not bound yet</NativeSelectOption>
                {nodeIds.map((nodeId) => (
                  <NativeSelectOption key={nodeId} value={nodeId}>
                    {nodeId}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Labelled>
        </div>
      ))}
    </div>
  );
}

/**
 * Problems with the draft.
 *
 * Errors and warnings are visually distinct and both are always listed. The distinction is load-bearing:
 * an unbound manifest is a legitimate thing to save, so hiding warnings would look like nothing is wrong,
 * and treating them as errors would block the spec's own workflow.
 */
function Issues({ issues }: { readonly issues: readonly DraftIssue[] }): ReactNode {
  if (issues.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Problems</span>
      <ItemGroup aria-label="Draft problems" role="list" className="gap-0.5">
        {issues.map((issue) => (
          <Item
            key={`${issue.severity}-${issue.path}-${issue.message}`}
            role="listitem"
            size="xs"
            className="py-0.5"
          >
            <Badge variant={issue.severity === 'error' ? 'destructive' : 'outline'}>
              <TriangleAlertIcon />
              {issue.severity}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">{issue.path}</span>
            <span className="text-sm">{issue.message}</span>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}

/**
 * The manifest that will be written.
 *
 * Shown because the file is the durable artefact — it is checked in, hand-edited and diffed — and a user
 * who cannot see it has to save and reopen to find out what the form did.
 */
function Preview({ draft }: { readonly draft: ManifestDraft }): ReactNode {
  // The JSON form, not `toManifest`: the preview must survive a draft whose id is still empty.
  const json = useMemo(() => JSON.stringify(draftManifestJson(draft), null, 2), [draft]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Manifest</span>
      <pre
        aria-label="Manifest preview"
        className="max-h-65 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs text-muted-foreground"
      >
        {json}
      </pre>
    </div>
  );
}

/**
 * What the generator takes.
 *
 * §5.2 makes this the declaration the whole framework turns on: a manifest says what it consumes and
 * produces, and the UI derives *where the action appears* from that. §5.9 promises the inspector writes
 * manifests without anyone touching code — and this had no control at all, so everything authored here
 * declared it consumed nothing and had to be finished by hand-editing the JSON.
 *
 * Suggested from the parameters rather than asked for twice: a parameter of type `image` is a generator
 * taking an image, and asking again invites the two to disagree. What the derivation cannot invent is
 * the **role** — `first_frame` and `style_reference` are both images — so that stays editable, and it
 * defaults to the parameter's key, which is what binds a text input's sources to its parameter.
 */
function Consumes({
  draft,
  onChange,
}: {
  readonly draft: ManifestDraft;
  readonly onChange?: (draft: ManifestDraft) => void;
}): ReactNode {
  const suggestions = missingConsumes(draft.consumes, suggestedConsumes(draft.params));
  const unmatched = unmatchedConsumes(draft.consumes, draft.params);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Consumes</span>
        {suggestions.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => onChange?.({ ...draft, consumes: [...draft.consumes, ...suggestions] })}
          >
            <PlusIcon />
            {`Add ${suggestions.length} from parameters`}
          </Button>
        )}
      </div>

      {draft.consumes.length === 0 && (
        <p className="font-mono text-xs text-muted-foreground">
          nothing declared — the surfaces this generator appears on are derived from these
        </p>
      )}

      {draft.consumes.map((input, index) => (
        <div key={`${input.type}:${input.role ?? index}`} className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
            <Labelled label="Role">
              {(id) => (
                <Input
                  id={id}
                  value={input.role ?? ''}
                  onChange={(event) =>
                    onChange?.({
                      ...draft,
                      consumes: editConsumes(draft.consumes, index, { role: event.target.value }),
                    })
                  }
                />
              )}
            </Labelled>
            <Labelled label="Type">
              {(id) => <Input id={id} value={input.type} readOnly aria-readonly="true" />}
            </Labelled>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${input.role ?? input.type}`}
              onClick={() => onChange?.({ ...draft, consumes: removeConsumes(draft.consumes, index) })}
            >
              <Trash2Icon />
            </Button>
          </div>

          {/* Sources are a text-only notion: on an image input they would be a field every reader
              ignores and the next author has to explain away. */}
          {input.type === 'text' && (
            <div className="flex flex-wrap items-center gap-3 pl-1">
              {TEXT_SOURCES.map((source) => (
                <Label key={source} className="flex items-center gap-1.5 text-xs font-normal">
                  <Checkbox
                    checked={(input.sources ?? []).includes(source)}
                    onCheckedChange={(checked) => {
                      const current = new Set(input.sources ?? []);
                      if (checked === true) current.add(source);
                      else current.delete(source);
                      onChange?.({
                        ...draft,
                        consumes: editConsumes(draft.consumes, index, {
                          sources: TEXT_SOURCES.filter((entry) => current.has(entry)),
                        }),
                      });
                    }}
                  />
                  {source}
                </Label>
              ))}
            </div>
          )}
        </div>
      ))}

      {unmatched.length > 0 && (
        <p className="font-mono text-xs text-muted-foreground">
          {`${unmatched.map((input) => input.role ?? input.type).join(', ')}: no parameter of that key, so the panel cannot ask for it`}
        </p>
      )}
    </div>
  );
}

/**
 * Where an enum's choices come from.
 *
 * Shown only for `enum`, beside the range fields that appear only for numbers — an inspector that
 * offers meaningless fields teaches the user to ignore all of them.
 *
 * It exists because `enum` was in the type list and had no field at all: choosing it produced "an enum
 * needs options", Save is disabled while a draft has errors, and nothing on screen could clear it. A
 * type you can pick and cannot finish is worse than one that is not offered.
 *
 * Both shapes the file format allows are here, as one control with a mode rather than two fields,
 * because they answer the same question — *where do the choices come from* — and a parameter carrying
 * both at once has no meaning in the format.
 */
function ChoiceEditor({
  param,
  onEdit,
}: {
  readonly param: DraftParam;
  readonly onEdit?: (id: string, changes: DraftParamChanges) => void;
}): ReactNode {
  const mode = choiceMode(param.options);
  const source = capabilitySource(param.options);

  /*
   * The list field holds what was *typed*, not a re-rendering of what was parsed.
   *
   * Derived straight from the draft it is unusable, and only driving it showed why: the moment you
   * type the comma between two values, `parseChoices` drops the empty entry after it, the field
   * re-renders from the shortened list, and the comma vanishes under the cursor. A second value can
   * never be entered.
   *
   * So the text is local and the draft is written on every keystroke. It is re-seeded only when the
   * draft's list is not what this field currently spells — which is true when the mode changes or
   * another parameter is selected, and false while someone is mid-word.
   */
  const [text, setText] = useState(() => choicesAsText(param.options));
  useEffect(() => {
    const stored = choicesAsText(param.options);
    setText((current) => (choicesAsText(parseChoices(current)) === stored ? current : stored));
  }, [param.options]);

  return (
    <div className="grid items-end gap-3 grid-cols-[0.8fr_1fr_1fr]">
      <Labelled label="Choices">
        {(id) => (
          <NativeSelect
            id={id}
            className="w-full"
            value={mode}
            onChange={(event) =>
              onEdit?.(param.id, {
                options: optionsForMode(event.target.value as 'list' | 'capabilities', param.options),
              })
            }
          >
            <NativeSelectOption value="list">a fixed list</NativeSelectOption>
            <NativeSelectOption value="capabilities">from the backend</NativeSelectOption>
          </NativeSelect>
        )}
      </Labelled>
      {mode === 'list' ? (
        <Labelled label="Values, comma separated">
          {(id) => (
            <Input
              id={id}
              className="col-span-2"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                onEdit?.(param.id, { options: parseChoices(event.target.value) });
              }}
            />
          )}
        </Labelled>
      ) : (
        <>
          <Labelled label="Node class">
            {(id) => (
              <Input
                id={id}
                value={source.nodeClass}
                onChange={(event) =>
                  onEdit?.(param.id, {
                    options: toCapabilityOptions(event.target.value, source.input),
                  })
                }
              />
            )}
          </Labelled>
          <Labelled label="Input">
            {(id) => (
              <Input
                id={id}
                value={source.input}
                onChange={(event) =>
                  onEdit?.(param.id, {
                    options: toCapabilityOptions(source.nodeClass, event.target.value),
                  })
                }
              />
            )}
          </Labelled>
        </>
      )}
    </div>
  );
}

/**
 * The fields that decide how a parameter behaves, rather than what it is.
 *
 * A second row so the first stays scannable: a reader running down a list of twenty parameters is
 * looking for keys and types, and burying those among six more controls each would cost more than the
 * controls are worth. Rendered only when the type actually has some of them — a seed has none, and an
 * empty row would read as a panel that failed to draw.
 */
function ParamBehaviour({
  param,
  onEdit,
}: {
  readonly param: DraftParam;
  readonly onEdit?: (id: string, changes: DraftParamChanges) => void;
}): ReactNode {
  const has = (field: ParamField): boolean => hasField(param.type, field);
  const control = defaultControl(param.type);
  const choices = Array.isArray(param.options) ? param.options : [];

  if (!has('default') && !has('transport') && !has('multiline') && !has('defaultFrom')) {
    return <RequiredToggle param={param} {...(onEdit !== undefined ? { onEdit } : {})} />;
  }

  return (
    <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
      {control !== 'none' && (
        <Labelled label="Default">
          {(id) =>
            control === 'boolean' || control === 'choice' ? (
              <NativeSelect
                id={id}
                className="w-full"
                value={defaultAsText(param.default)}
                onChange={(event) =>
                  onEdit?.(param.id, { default: parseDefault(param.type, event.target.value) })
                }
              >
                {/* An empty entry, because "no default" is a real state the format distinguishes from
                    a default of `false` — absent means the graph's own value stands. */}
                <NativeSelectOption value="">no default</NativeSelectOption>
                {(control === 'boolean' ? ['true', 'false'] : choices).map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {value}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <Input
                id={id}
                {...(control === 'number' ? { type: 'number' } : {})}
                value={defaultAsText(param.default)}
                onChange={(event) =>
                  onEdit?.(param.id, { default: parseDefault(param.type, event.target.value) })
                }
              />
            )
          }
        </Labelled>
      )}

      {has('defaultFrom') && (
        <Labelled label="Or derived from">
          {(id) => (
            <NativeSelect
              id={id}
              className="w-full"
              value={param.defaultFrom ?? ''}
              onChange={(event) =>
                onEdit?.(param.id, {
                  defaultFrom: event.target.value === '' ? undefined : event.target.value,
                })
              }
            >
              {/* A closed list: these are the things the *application* can work out, and one the
                  application does not know is a default that never resolves. */}
              <NativeSelectOption value="">nothing</NativeSelectOption>
              {DERIVED_DEFAULTS.map((source) => (
                <NativeSelectOption key={source} value={source}>
                  {source}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Labelled>
      )}

      {has('transport') && (
        <Labelled label="Transport">
          {(id) => (
            <Input
              id={id}
              // How the file reaches the backend. Free text rather than a list, because it is the
              // backend's vocabulary and no concrete backend belongs in this code.
              placeholder="upload_image"
              value={param.transport ?? ''}
              onChange={(event) =>
                onEdit?.(param.id, {
                  transport: event.target.value === '' ? undefined : event.target.value,
                })
              }
            />
          )}
        </Labelled>
      )}

      <div className="flex items-center gap-4 pb-2">
        {has('multiline') && (
          <Label className="flex items-center gap-2 text-xs font-normal">
            <Checkbox
              checked={param.multiline === true}
              onCheckedChange={(checked) =>
                onEdit?.(param.id, { multiline: checked === true ? true : undefined })
              }
            />
            Multiline
          </Label>
        )}
        <RequiredToggle param={param} {...(onEdit !== undefined ? { onEdit } : {})} />
      </div>
    </div>
  );
}

/**
 * Whether a run can proceed without a value.
 *
 * Its own component because it is the one behaviour field every type has, so it appears both inside
 * the behaviour row and on its own for the types that have nothing else.
 */
function RequiredToggle({
  param,
  onEdit,
}: {
  readonly param: DraftParam;
  readonly onEdit?: (id: string, changes: DraftParamChanges) => void;
}): ReactNode {
  return (
    <Label className="flex items-center gap-2 text-xs font-normal">
      <Checkbox
        checked={param.required === true}
        // Cleared rather than set to `false`: the format's absent and `false` mean the same thing, and
        // writing the second puts a field in every manifest that every reader has to skip.
        onCheckedChange={(checked) => onEdit?.(param.id, { required: checked === true ? true : undefined })}
      />
      Required
    </Label>
  );
}
