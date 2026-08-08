import { type ReactNode, useMemo, useState } from 'react';
import {
  type DraftIssue,
  type DraftParam,
  type DraftParamChanges,
  type GeneratorParamType,
  type GraphLiteral,
  type ManifestDraft,
  PARAM_TYPES,
  draftHasErrors,
  draftManifestJson,
  validateDraft,
} from '@nos/generators';
import { Badge, Button, Mono, PanelHeader, SectionCaption } from '../primitives/Primitives.js';
import { token } from '../tokens/tokens.js';

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
    <section
      aria-label="Manifest inspector"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: token.bgPanel,
        color: token.textPrimary,
      }}
    >
      <PanelHeader
        caption="Manifest inspector"
        trailing={
          <div style={{ display: 'flex', alignItems: 'center', gap: token.space2 }}>
            <Badge tone={blocked ? 'danger' : draft.graph === null ? 'warn' : 'ok'}>
              {blocked ? 'incomplete' : draft.graph === null ? 'unbound' : 'ready'}
            </Badge>
            <Button
              tone="primary"
              disabled={blocked}
              onClick={onSave}
              title={blocked ? 'Fix the errors below first' : 'Write the manifest'}
            >
              Save manifest
            </Button>
          </div>
        }
      />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
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
    <div
      style={{
        width: 380,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        borderRight: `1px solid ${token.border}`,
        minHeight: 0,
      }}
    >
      <div style={{ padding: token.space4, borderBottom: `1px solid ${token.borderSubtle}` }}>
        <input
          type="search"
          aria-label="Filter graph inputs"
          placeholder="Filter by node, input or value"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          style={{
            width: '100%',
            height: token.controlHeight,
            background: token.surface1,
            border: `1px solid ${token.borderControl}`,
            borderRadius: token.radiusControl,
            color: token.textBright,
            font: `400 11.5px ${token.fontUi}`,
            padding: `0 ${token.space3}`,
          }}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: token.space3 }}>
        {groups.length === 0 && (
          <Mono tone={token.textFaint}>no graph inputs — load a graph, or clear the filter</Mono>
        )}
        {groups.map((group) => (
          <div key={group.nodeId} style={{ marginBottom: token.space4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: token.space2, padding: token.space2 }}>
              <SectionCaption>{group.nodeClass}</SectionCaption>
              <Mono tone={token.textGhost}>{group.nodeId}</Mono>
            </div>

            {group.literals.map((literal) => {
              const param = promoted.get(literal.pointer);
              const ticked = param !== undefined;
              return (
                <label
                  key={literal.pointer}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: token.space3,
                    height: token.controlHeight,
                    padding: `0 ${token.space2}`,
                    borderRadius: token.radiusInset,
                    background: ticked ? 'rgba(155, 140, 255, 0.10)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ticked}
                    aria-label={`${literal.input} on ${literal.nodeClass} ${literal.nodeId}`}
                    onChange={() => {
                      if (ticked) onDemote?.(param.id);
                      else onPromote?.(literal);
                    }}
                  />
                  <span style={{ font: `400 11.5px ${token.fontUi}`, color: token.textSecondary }}>
                    {literal.input}
                  </span>
                  <div style={{ flex: 1 }} />
                  <Mono
                    tone={token.textFaint}
                    style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {String(literal.value)}
                  </Mono>
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
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
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: token.space5, display: 'flex', flexDirection: 'column', gap: token.space5 }}>
        <Identity draft={draft} {...(onChange !== undefined ? { onChange } : {})} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: token.space3 }}>
          <SectionCaption>Parameters</SectionCaption>
          {draft.params.length === 0 && (
            <Mono tone={token.textFaint}>tick a graph input on the left to make it a parameter</Mono>
          )}
          {draft.params.map((param) => (
            <ParamRow
              key={param.id}
              param={param}
              {...(onEditParam !== undefined ? { onEdit: onEditParam } : {})}
            />
          ))}
        </div>

        <Outputs draft={draft} nodeIds={nodeIds} {...(onChange !== undefined ? { onChange } : {})} />
        <Issues issues={issues} />
        <Preview draft={draft} />
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: token.space2, minWidth: 0 }}>
      <span style={{ font: token.textLabel, color: token.textSoft }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle = {
  height: token.controlHeight,
  background: token.surface1,
  border: `1px solid ${token.borderControl}`,
  borderRadius: token.radiusControl,
  color: token.textBright,
  font: `400 11.5px ${token.fontUi}`,
  padding: `0 ${token.space3}`,
  minWidth: 0,
} as const;

function Identity({
  draft,
  onChange,
}: {
  readonly draft: ManifestDraft;
  readonly onChange?: (draft: ManifestDraft) => void;
}): ReactNode {
  const set = (changes: Partial<ManifestDraft>): void => onChange?.({ ...draft, ...changes });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: token.space3 }}>
      <Field label="Id">
        <input style={inputStyle} value={draft.id} onChange={(event) => set({ id: event.target.value })} />
      </Field>
      <Field label="Name">
        <input style={inputStyle} value={draft.name} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      <Field label="Backend">
        <input
          style={inputStyle}
          value={draft.backend}
          onChange={(event) => set({ backend: event.target.value })}
        />
      </Field>
      <Field label="Produces">
        <select
          style={inputStyle}
          value={draft.produces}
          onChange={(event) => set({ produces: event.target.value as ManifestDraft['produces'] })}
        >
          {['video', 'audio', 'image', 'text'].map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Length">
        <select
          style={inputStyle}
          value={draft.duration}
          onChange={(event) => set({ duration: event.target.value as ManifestDraft['duration'] })}
        >
          <option value="declared">declared — a parameter sets it</option>
          <option value="discovered">discovered — only the output says</option>
        </select>
      </Field>
      <Field label="Default variants">
        <input
          type="number"
          min={1}
          max={16}
          style={inputStyle}
          value={draft.defaultVariants}
          onChange={(event) => set({ defaultVariants: Number(event.target.value) })}
        />
      </Field>
      <Field label="Surfaces">
        <input
          style={inputStyle}
          value={draft.surfaces.join(', ')}
          placeholder="media_browser, clip_context_menu"
          onChange={(event) => set({ surfaces: splitList(event.target.value) })}
        />
      </Field>
      <Field label="Requires node classes">
        <input
          style={inputStyle}
          value={draft.requires.join(', ')}
          onChange={(event) => set({ requires: splitList(event.target.value) })}
        />
      </Field>
      <Field label="Graph file">
        <input
          style={inputStyle}
          value={draft.graph ?? ''}
          placeholder="not connected yet"
          onChange={(event) => set({ graph: event.target.value === '' ? null : event.target.value })}
        />
      </Field>
    </div>
  );
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * One parameter row.
 *
 * The range fields appear only for numeric types, because a minimum on a boolean is meaningless and an
 * inspector that offers meaningless fields teaches the user to ignore all of them.
 */
function ParamRow({
  param,
  onEdit,
}: {
  readonly param: DraftParam;
  readonly onEdit?: (id: string, changes: DraftParamChanges) => void;
}): ReactNode {
  const numeric = param.type === 'int' || param.type === 'float';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: numeric ? '1.2fr 1fr 0.7fr 0.7fr' : '1.2fr 1fr',
        gap: token.space3,
        alignItems: 'end',
        padding: token.space3,
        background: token.surface1,
        borderRadius: token.radiusInset,
        border: `1px solid ${token.borderSubtle}`,
      }}
    >
      <Field label={`Key · ${param.pointer === '' ? 'not bound' : param.pointer}`}>
        <input
          style={inputStyle}
          value={param.key}
          onChange={(event) => onEdit?.(param.id, { key: event.target.value })}
        />
      </Field>
      <Field label="Type">
        <select
          style={inputStyle}
          value={param.type}
          onChange={(event) => onEdit?.(param.id, { type: event.target.value as GeneratorParamType })}
        >
          {PARAM_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </Field>
      {numeric && (
        <>
          <Field label="Min">
            <input
              type="number"
              style={inputStyle}
              value={param.min ?? ''}
              onChange={(event) =>
                onEdit?.(param.id, { min: event.target.value === '' ? undefined : Number(event.target.value) })
              }
            />
          </Field>
          <Field label="Max">
            <input
              type="number"
              style={inputStyle}
              value={param.max ?? ''}
              onChange={(event) =>
                onEdit?.(param.id, { max: event.target.value === '' ? undefined : Number(event.target.value) })
              }
            />
          </Field>
        </>
      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: token.space3 }}>
        <SectionCaption>Outputs</SectionCaption>
        <div style={{ flex: 1 }} />
        <Button
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
          Add output
        </Button>
      </div>

      {draft.outputs.map((output, index) => (
        <div
          key={output.key}
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: token.space3, alignItems: 'end' }}
        >
          <Field label="Key">
            <input
              style={inputStyle}
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
          </Field>
          <Field label="Node">
            <select
              style={inputStyle}
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
              <option value="">not bound yet</option>
              {nodeIds.map((nodeId) => (
                <option key={nodeId} value={nodeId}>
                  {nodeId}
                </option>
              ))}
            </select>
          </Field>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space2 }}>
      <SectionCaption>Problems</SectionCaption>
      <ul aria-label="Draft problems" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {issues.map((issue) => (
          <li
            key={`${issue.severity}-${issue.path}-${issue.message}`}
            style={{ display: 'flex', gap: token.space2, alignItems: 'baseline', padding: '2px 0' }}
          >
            <Badge tone={issue.severity === 'error' ? 'danger' : 'warn'}>{issue.severity}</Badge>
            <Mono tone={token.textGhost}>{issue.path}</Mono>
            <span style={{ font: `400 11.5px ${token.fontUi}`, color: token.textSecondary }}>
              {issue.message}
            </span>
          </li>
        ))}
      </ul>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space2 }}>
      <SectionCaption>Manifest</SectionCaption>
      <pre
        aria-label="Manifest preview"
        style={{
          margin: 0,
          padding: token.space4,
          background: token.bgCanvas,
          border: `1px solid ${token.borderSubtle}`,
          borderRadius: token.radiusInset,
          color: token.textFaint,
          font: token.textMeta,
          maxHeight: 260,
          overflow: 'auto',
        }}
      >
        {json}
      </pre>
    </div>
  );
}
