import { type ReactNode, useMemo, useState } from 'react';
import { type FrameIndex, type PresetId, clipId, frameIndex, spanFromBounds, trackId } from '@nos/core';
import type {
  GeneratorManifest,
  GeneratorRegistry,
  JobTarget,
  RegistryRecord,
  SelectionOutcome,
} from '@nos/generators';
import { acceptSelection, buildSelection } from '@nos/generators';
import { type MaskSession, beginSession, emptyTrack, maskTrackId } from '@nos/masks';
import { Button, GeneratorPanel, Mono, PanelHeader, SegmentationPanel, VariantPicker } from '@nos/ui';
import type { GeneratorRuntime } from './use-generator-runtime.js';
import type { LibraryProblem } from './use-generator-library.js';

/**
 * The right-hand panel.
 *
 * One column, four tools, chosen by a tab strip: the clip inspector, the generator panel, the variant
 * picker for whatever is currently staged, and segmentation. A tab strip rather than four stacked panels
 * because the mockups' inspector is 340 px wide and stacking them would push every control below the
 * fold on a laptop.
 *
 * Everything shown here is a rendering of a value the packages produce. The panel chooses *which*
 * value; it decides nothing about generators, masks or edits.
 */

export type PanelTab = 'inspector' | 'generate' | 'variants' | 'segment';

export interface RightPanelProps {
  readonly registry: GeneratorRegistry | undefined;
  /** Lands an accepted variant on the timeline. Supplied by the shell, which owns the document. */
  readonly onAcceptVariant: (outcome: SelectionOutcome, manifest: GeneratorManifest) => void;
  readonly libraryProblems: readonly LibraryProblem[];
  readonly runtime: GeneratorRuntime;
  readonly playhead: FrameIndex;
  readonly selectedClip: string | undefined;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onSplit: () => void;
  readonly onNudge: (delta: number) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

export function RightPanel(props: RightPanelProps): ReactNode {
  const [tab, setTab] = useState<PanelTab>('inspector');

  return (
    <aside
      aria-label="Inspector"
      style={{
        width: 340,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--nos-border)',
        background: 'var(--nos-bg-panel)',
        minHeight: 0,
      }}
    >
      <PanelHeader>
        <div role="tablist" aria-label="Panel" style={{ display: 'flex', gap: 4 }}>
          {(['inspector', 'generate', 'variants', 'segment'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              onClick={() => setTab(entry)}
              style={{
                height: 24,
                padding: '0 8px',
                borderRadius: 4,
                background: tab === entry ? '#1c2333' : 'transparent',
                border: `1px solid ${tab === entry ? '#2f4a72' : 'transparent'}`,
                color: tab === entry ? '#9dc2ff' : 'var(--nos-text-muted)',
                font: '500 11px system-ui, sans-serif',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {entry}
            </button>
          ))}
        </div>
      </PanelHeader>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {tab === 'inspector' && <ClipInspector {...props} />}
        {tab === 'generate' && <GenerateTab {...props} />}
        {tab === 'variants' && <VariantsTab {...props} />}
        {tab === 'segment' && <SegmentTab {...props} />}
      </div>
    </aside>
  );
}

function ClipInspector({
  selectedClip,
  canUndo,
  canRedo,
  onSplit,
  onNudge,
  onUndo,
  onRedo,
}: RightPanelProps): ReactNode {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Mono tone="var(--nos-text-faint)">{selectedClip ?? 'no clip selected'}</Mono>
      <Button onClick={onSplit} disabled={selectedClip === undefined}>
        Split at playhead
      </Button>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          onClick={() => onNudge(-1)}
          disabled={selectedClip === undefined}
          title="Nudge one frame left"
        >
          ◀ 1f
        </Button>
        <Button
          onClick={() => onNudge(1)}
          disabled={selectedClip === undefined}
          title="Nudge one frame right"
        >
          1f ▶
        </Button>
      </div>
      <Button onClick={onUndo} disabled={!canUndo}>
        Undo
      </Button>
      <Button onClick={onRedo} disabled={!canRedo}>
        Redo
      </Button>
    </div>
  );
}

/**
 * The generator tab.
 *
 * Lists every record the registry holds — **including the unrunnable ones**, greyed with their reason,
 * which is the spec's explicit rule. A tool that silently disappears turns "where is my generator" into
 * an afternoon of debugging.
 */
function GenerateTab({ registry, libraryProblems, runtime, playhead }: RightPanelProps): ReactNode {
  const records = registry?.all() ?? [];
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [preset, setPreset] = useState<PresetId | undefined>(undefined);
  const [params, setParams] = useState<Readonly<Record<string, string | number | boolean>>>({});
  const [variantCount, setVariantCount] = useState<number | undefined>(undefined);
  const [lockedSeed, setLockedSeed] = useState<number | undefined>(undefined);
  const [destination, setDestination] = useState<'media-browser' | 'timeline'>('media-browser');

  const record: RegistryRecord | undefined =
    records.find((entry) => entry.manifest.id === selectedId) ?? records[0];

  /**
   * Where the output goes.
   *
   * Offered rather than inferred. The manifest's surfaces say where the *action* appears; they do not
   * say whether this particular run is material for the bin or a clip for the cut, and that is a
   * decision only the user makes.
   */
  const target: JobTarget =
    destination === 'timeline' && record !== undefined
      ? {
          kind: 'timeline',
          track: record.manifest.produces === 'audio' ? trackId('A1') : trackId('V1'),
          at: playhead,
        }
      : { kind: 'media-browser' };

  if (records.length === 0) {
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Mono tone="var(--nos-text-faint)">no manifests in the project&apos;s generators/ folder</Mono>
        {libraryProblems.map((problem) => (
          <Mono key={problem.file} tone="var(--nos-danger)">{`${problem.file}: ${problem.detail}`}</Mono>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Mono tone={runtime.mode === 'comfyui' ? 'var(--nos-ok)' : 'var(--nos-warn)'}>{runtime.detail}</Mono>
        {runtime.error !== undefined && <Mono tone="var(--nos-danger)">{runtime.error}</Mono>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ font: '400 11px system-ui', color: 'var(--nos-text-soft)' }}>Send to</span>
          <select
            aria-label="Destination"
            value={destination}
            onChange={(event) => setDestination(event.target.value as 'media-browser' | 'timeline')}
            style={{
              flex: 1,
              height: 24,
              background: 'var(--nos-surface-1)',
              border: '1px solid var(--nos-border-control)',
              borderRadius: 4,
              color: 'var(--nos-text-bright)',
              font: '400 11px system-ui, sans-serif',
            }}
          >
            <option value="media-browser">the media browser</option>
            <option value="timeline">the timeline, at the playhead</option>
          </select>
        </label>
        <select
          aria-label="Generator"
          value={record?.manifest.id ?? ''}
          onChange={(event) => {
            setSelectedId(event.target.value);
            setPreset(undefined);
            setParams({});
          }}
          style={{
            height: 26,
            background: 'var(--nos-surface-1)',
            border: '1px solid var(--nos-border-control)',
            borderRadius: 4,
            color: 'var(--nos-text-bright)',
            font: '400 11.5px system-ui, sans-serif',
          }}
        >
          {records.map((entry) => (
            <option key={entry.manifest.id} value={entry.manifest.id}>
              {entry.manifest.name}
              {entry.status === 'available' ? '' : ` — ${entry.status}`}
            </option>
          ))}
        </select>
      </div>

      {record !== undefined && (
        <GeneratorPanel
          record={record}
          params={params}
          {...(preset !== undefined ? { preset } : {})}
          {...(variantCount !== undefined ? { variantCount } : {})}
          {...(lockedSeed !== undefined ? { lockedSeed } : {})}
          {...(runtime.capabilities !== undefined
            ? { capabilityOptions: runtime.capabilities.enumOptions }
            : {})}
          onChangeParam={(key, value) => setParams((current) => ({ ...current, [key]: value }))}
          onChangePreset={setPreset}
          onChangeVariantCount={setVariantCount}
          onToggleSeedLock={() =>
            setLockedSeed((current) =>
              current === undefined ? Math.floor(Math.random() * 2 ** 31) : undefined,
            )
          }
          onRun={() =>
            runtime.run({
              manifest: record.manifest,
              params,
              target,
              ...(preset !== undefined ? { preset } : {}),
              ...(variantCount !== undefined ? { variantCount } : {}),
              ...(lockedSeed !== undefined ? { lockedSeed } : {}),
            })
          }
        />
      )}
    </div>
  );
}

/**
 * The variants tab.
 *
 * Shows the most recent group's candidates. Partial results are selectable the moment they land, which
 * is the behaviour the spec asks for and the reason the picker is driven by a derived selection rather
 * than by a "generation finished" event.
 */
function VariantsTab({ runtime, registry, onAcceptVariant }: RightPanelProps): ReactNode {
  const [current, setCurrent] = useState<string | undefined>(undefined);

  const group = runtime.snapshot.groups[runtime.snapshot.groups.length - 1];
  const manifest = group === undefined ? undefined : registry?.manifestFor(group.generator);

  const selection = useMemo(() => {
    if (group === undefined || manifest === undefined) return undefined;
    return buildSelection({
      group,
      runs: runtime.snapshot.runs.filter((run) => run.group === group.id),
      manifest,
      ...(current !== undefined ? { current: current as never } : {}),
    });
  }, [group, manifest, runtime.snapshot.runs, current]);

  if (selection === undefined) {
    return (
      <div style={{ padding: 16 }}>
        <Mono tone="var(--nos-text-faint)">nothing has been generated yet</Mono>
      </div>
    );
  }

  return (
    <div style={{ padding: 12 }}>
      <VariantPicker
        selection={selection}
        onSelect={(run) => setCurrent(run)}
        onStep={(delta) => {
          const ready = selection.candidates.filter((candidate) => candidate.ready);
          if (ready.length === 0) return;
          const index = ready.findIndex((candidate) => candidate.run === selection.current?.run);
          const next = ready[(((index + delta) % ready.length) + ready.length) % ready.length];
          if (next !== undefined) setCurrent(next.run);
        }}
        onAccept={() => {
          const outcome = acceptSelection(selection);
          // `acceptSelection` returns nothing when no variant is ready; the picker disables the control
          // in that case, so this guard is for the keyboard path.
          if (outcome !== undefined && manifest !== undefined) onAcceptVariant(outcome, manifest);
        }}
        onDiscard={() => runtime.cancelGroup(selection.group)}
      />
    </div>
  );
}

/**
 * The segmentation tab.
 *
 * Bound to the selected clip, because a mask belongs to one clip's range. With nothing selected there is
 * no range to propagate over, and the panel says so rather than offering a control that cannot work.
 */
function SegmentTab({ selectedClip, playhead }: RightPanelProps): ReactNode {
  const [session, setSession] = useState<MaskSession | undefined>(undefined);

  const active = useMemo(() => {
    if (selectedClip === undefined) return undefined;
    if (session?.track.clip === selectedClip) return session;
    return beginSession(
      emptyTrack(
        maskTrackId(`${selectedClip}-mask`),
        clipId(selectedClip),
        spanFromBounds(frameIndex(0), frameIndex(300)),
      ),
      playhead,
    );
  }, [selectedClip, session, playhead]);

  if (active === undefined) {
    return (
      <div style={{ padding: 16 }}>
        <Mono tone="var(--nos-text-faint)">select a clip to segment</Mono>
      </div>
    );
  }

  return (
    <SegmentationPanel
      session={active}
      capabilities={{
        available: false,
        propagates: false,
        // Reported rather than hidden. The sidecar answers `/segment/capabilities` with the real reason
        // once a project is open; this is the pre-connection state.
        detail: 'connect a project to check whether SAM 2 is installed',
      }}
      onChangePropagation={(span) =>
        setSession((current) => (current ? { ...current, propagation: span } : current))
      }
    />
  );
}
