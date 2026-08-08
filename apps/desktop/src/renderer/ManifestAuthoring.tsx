import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  type GraphLiteral,
  type ManifestDraft,
  demote,
  draftHasErrors,
  draftToFile,
  editParam,
  emptyDraft,
  fromManifest,
  graphNodeIds,
  promote,
} from '@nos/generators';
import { collectLiterals } from '@nos/backend-comfyui';
import { Button, ManifestInspector, Mono, SectionCaption } from '@nos/ui';
import { token } from '@nos/ui';
import type { DesktopBridge } from '../main/ipc-contract.js';
import { GENERATORS_FOLDER } from './use-generator-library.js';

/**
 * Authoring a manifest (spec §5.9).
 *
 * "A manifestet nem kézzel írjuk" — the manifest is not written by hand. Drop a ComfyUI export into the
 * project's `generators/` folder, pick it here, tick the inputs that should become parameters, and save.
 * The registry picks the file up on the next load and the generator appears in the panel.
 *
 * This is the screen that makes the framework's central claim true rather than merely architectural: a
 * new generative capability requires **no code**, and nothing in this application knows what any
 * particular generator is.
 */

export interface ManifestAuthoringProps {
  /** Graph filenames already loaded, so the picker needs no second directory read. */
  readonly graphs: ReadonlyMap<string, unknown>;
  readonly onClose: () => void;
  /** Called after a successful write, so the library reloads and the registry revalidates. */
  readonly onSaved: () => void;
}

function bridge(): DesktopBridge | undefined {
  return (globalThis as { nos?: DesktopBridge }).nos;
}

export function ManifestAuthoring({ graphs, onClose, onSaved }: ManifestAuthoringProps): ReactNode {
  const [graph, setGraph] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<ManifestDraft>(() => emptyDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Chosen for the user when there is only one candidate: making them pick from a list of one is a step
  // that exists only because the code found it easier.
  useEffect(() => {
    if (graph === undefined && graphs.size === 1) {
      const only = [...graphs.keys()][0];
      if (only !== undefined) setGraph(only);
    }
  }, [graph, graphs]);

  const parsed = graph === undefined ? undefined : graphs.get(graph);
  const literals = useMemo(() => (parsed === undefined ? [] : collectLiterals(parsed)), [parsed]);
  const nodeIds = useMemo(() => (parsed === undefined ? [] : graphNodeIds(parsed)), [parsed]);

  const choose = useCallback((name: string) => {
    setGraph(name);
    // The graph name goes straight into the draft: it is the one field a user would otherwise have to
    // retype exactly, and a typo there is an `unavailable` generator with a confusing reason.
    setDraft((current) => ({ ...current, graph: name }));
    setError(undefined);
  }, []);

  const save = useCallback(async () => {
    const api = bridge();
    if (api === undefined) {
      setError('the desktop bridge is unavailable, so nothing can be written');
      return;
    }

    setSaving(true);
    try {
      const file = `${GENERATORS_FOLDER}/${draft.id}.manifest.json`;
      // Two-space JSON, like the manifests that ship with the project: these files are read, diffed and
      // hand-edited, and a single line of minified JSON would end that.
      await api.writeTextFile(file, `${JSON.stringify(draftToFile(draft), null, 2)}\n`);
      onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, [draft, onClose, onSaved]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Author a manifest"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        background: token.bgApp,
      }}
    >
      <header
        style={{
          height: 44,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: `0 ${token.space5}`,
          borderBottom: `1px solid ${token.border}`,
        }}
      >
        <SectionCaption>Author a manifest</SectionCaption>

        <select
          aria-label="Graph"
          value={graph ?? ''}
          onChange={(event) => choose(event.target.value)}
          style={{
            height: token.controlHeight,
            background: token.surface1,
            border: `1px solid ${token.borderControl}`,
            borderRadius: token.radiusControl,
            color: token.textBright,
            font: `400 11.5px ${token.fontUi}`,
          }}
        >
          <option value="">choose a graph…</option>
          {[...graphs.keys()].map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        {graphs.size === 0 && (
          <Mono tone={token.warn}>
            {`put a ComfyUI export in the project's ${GENERATORS_FOLDER}/ folder to start`}
          </Mono>
        )}
        {error !== undefined && <Mono tone={token.danger}>{error}</Mono>}

        <div style={{ flex: 1 }} />
        <Button onClick={onClose}>Close</Button>
      </header>

      <div style={{ flex: 1, minHeight: 0 }}>
        <ManifestInspector
          draft={draft}
          literals={literals}
          nodeIds={nodeIds}
          onChange={setDraft}
          onPromote={(literal: GraphLiteral) => setDraft((current) => promote(current, literal))}
          onDemote={(id) => setDraft((current) => demote(current, id))}
          onEditParam={(id, changes) => setDraft((current) => editParam(current, id, changes))}
          onSave={() => void save()}
        />
      </div>

      {saving && <Mono tone={token.textFaint}>writing…</Mono>}
    </div>
  );
}

/** Reopens an existing manifest for editing, rather than starting from scratch. */
export function draftFromExisting(manifest: Parameters<typeof fromManifest>[0]): ManifestDraft {
  return fromManifest(manifest);
}

/** Whether a draft is ready to write. Mirrors the inspector's own gate, for a caller that wants it. */
export function canSave(draft: ManifestDraft): boolean {
  return !draftHasErrors(draft);
}
