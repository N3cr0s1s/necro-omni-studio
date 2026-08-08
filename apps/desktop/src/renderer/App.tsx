import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AutosaveStatus,
  type Clip,
  type ClipId,
  type FrameIndex,
  type FrameRate,
  type TimelineDocument,
  FRAME_RATES,
  createDocument,
  createDocumentStore,
  clipId,
  documentEnd,
  formatFrames,
  frameIndex,
  jobRunId,
  loadDocument,
  locateClip,
  projectId,
  saveDocument,
  sequenceId,
  trackId,
} from '@nos/core';
import { buildTree } from '@nos/media';
import { insertGenerated, moveClip, splitClip, trimClipEnd, trimClipStart } from '@nos/editing';
import { type GeneratorManifest, type SelectionOutcome, placeholderLength } from '@nos/generators';
import { Button, ExportDialog, MediaBrowser, Timeline, createViewport } from '@nos/ui';
import { type ExportSettings, DEFAULT_EXPORT } from '@nos/export';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import type { DesktopBridge, ProjectInfo, SidecarInfo } from '../main/ipc-contract.js';
import type { Transport } from './use-transport.js';
import { KeyframeLanes } from './KeyframeLanes.js';
import { ManifestAuthoring } from './ManifestAuthoring.js';
import { createTextClip } from './TextInspector.js';
import { Preview } from './Preview.js';
import { usePlaybackAudio } from './use-audio-engine.js';
import { useTransport, useTransportKeys } from './use-transport.js';
import { playbackEnd, useWorkRange } from './use-work-range.js';
import { describeAutosave, useAutosave } from './use-autosave.js';
import { useClipDrag } from './use-clip-drag.js';
import { useClipStrips } from './use-clip-strips.js';
import { useMediaImport } from './use-media-import.js';
import { defaultRange, describeTiming, useExportRun } from './use-export.js';
import { RightPanel } from './RightPanel.js';
import { useGeneratorLibrary } from './use-generator-library.js';
import { useGeneratorRuntime } from './use-generator-runtime.js';
import { useProjectTree } from './use-project-tree.js';

/**
 * The application shell.
 *
 * Composition only. Every decision it makes — what an edit does, how a frame is planned, what a
 * generator can run — belongs to a package, and this file's job is to hold the pieces together and own
 * the small amount of state that is genuinely about *this window*: which clip is selected, where the
 * playhead is, how far the timeline is zoomed.
 *
 * That division is what has kept the packages testable in Node, and it is why this file is short.
 */

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

/** Where the last opened project is remembered. One key: this is a preference, not a document. */
const LAST_PROJECT_KEY = 'nos.lastProject';

function emptyProject(name: string): TimelineDocument {
  return createDocument({
    id: projectId('project'),
    sequenceId: sequenceId('main'),
    name,
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });
}

/** The bridge, or `undefined` when the UI runs in a plain browser (the visual harness). */
function bridge(): DesktopBridge | undefined {
  return (globalThis as { nos?: DesktopBridge }).nos;
}

export function App(): ReactNode {
  const [project, setProject] = useState<ProjectInfo | undefined>(undefined);
  const [sidecar, setSidecar] = useState<SidecarInfo | undefined>(undefined);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [snap, setSnap] = useState(true);
  const [ripple, setRipple] = useState(false);
  const [widthPx, setWidthPx] = useState(1200);
  const [framesPerPixel, setFramesPerPixel] = useState(1);
  const [scrollFrame, setScrollFrame] = useState<FrameIndex>(frameIndex(0));
  const [error, setError] = useState<string | undefined>(undefined);

  const store = useMemo(() => createDocumentStore(emptyProject('Untitled')), []);
  const [document, setDocument] = useState<TimelineDocument>(() => store.getDocument());
  useEffect(() => store.subscribe(() => setDocument(store.getDocument())), [store]);

  const audio = usePlaybackAudio({ document, sidecar });
  const transport = useTransport({
    frameRate: document.frameRate,
    // Playback stops at the out point when one is marked. The range is the spec's bound on looped
    // playback as well as the export default, and honouring it in only one of the two would make the
    // preview disagree with the file it is supposed to be previewing.
    endFrame: playbackEnd(document, documentEnd(document)),
    audio,
  });
  useTransportKeys(transport);
  const playhead = transport.frame;

  // Autosave writes a recovery *sibling*, never `project.json`: an autosave that overwrote the file
  // would destroy the last state the user deliberately saved, the moment they started experimenting.
  const autosave = useAutosave({ store, projectRoot: project?.root, bridge: bridge() });

  const tree = useProjectTree(project?.root);
  // The runtime probes ComfyUI once and reports which backend is actually in use; the registry then
  // validates `requires` against the node classes that probe returned, so an unavailable generator is
  // greyed for the real reason rather than because the backend was still starting.
  const graphsRef = useRef<ReadonlyMap<string, unknown> | undefined>(undefined);
  const runtime = useGeneratorRuntime({ graphs: graphsRef });
  const library = useGeneratorLibrary(project?.root, {
    ...(runtime.capabilities !== undefined ? { installedNodeClasses: runtime.capabilities.nodeClasses } : {}),
  });
  const laneRef = useRef<HTMLDivElement | null>(null);

  // The lane width drives every frame-to-pixel conversion, so it is measured rather than assumed —
  // a hard-coded width would misplace the playhead on any window that is not exactly that size.
  useEffect(() => {
    const element = laneRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidthPx(Math.max(200, entry.contentRect.width - 148));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The queue patches from whatever the library last loaded, without being rebuilt — which would
  // otherwise drop every job in flight each time a manifest is edited.
  graphsRef.current = library.graphs;

  // One registry for the window: the preview, the export and the inspector must agree about which
  // effects exist and which of them compile.
  const effectRegistry = useMemo(() => createEffectRegistry(BUILTIN_EFFECTS), []);

  const commitDocument = useCallback(
    (label: string, next: TimelineDocument) => {
      store.commit(label, () => next);
    },
    [store],
  );

  const range = useWorkRange({
    document,
    playhead,
    commit: commitDocument,
    seek: transport.seek,
  });

  const viewport = useMemo(
    () => createViewport({ framesPerPixel, scrollFrame, widthPx, frameRate: document.frameRate }),
    [framesPerPixel, scrollFrame, widthPx, document.frameRate],
  );

  /**
   * Adopts an opened folder.
   *
   * Shared by the folder picker and the restore-on-launch path, so both produce exactly the same state.
   * Two of them would drift, and the difference would only appear on a relaunch.
   */
  const adopt = useCallback(
    async (opened: ProjectInfo, api: DesktopBridge) => {
      setProject(opened);
      setSidecar(await api.sidecarInfo());
      globalThis.localStorage?.setItem(LAST_PROJECT_KEY, opened.root);

      if (opened.document === undefined) {
        // A folder with no `project.json` is a *new* project, not a broken one.
        store.reset(emptyProject(opened.name));
        setError(undefined);
        return;
      }

      const loaded = loadDocument(opened.document);
      if (loaded.ok) {
        store.reset(loaded.value.document);
        setError(undefined);
      } else {
        // Never silently replaced with an empty timeline: that reads as "my project is gone".
        setError(`${opened.name}/project.json could not be read`);
      }
    },
    [store],
  );

  // Reopens the last project on launch. An editor that forgets what you were working on every time it
  // starts is one the user has to navigate a folder picker to use at all.
  useEffect(() => {
    const api = bridge();
    const last = globalThis.localStorage?.getItem(LAST_PROJECT_KEY);
    if (api === undefined || last === null || last === undefined || last === '') return;

    void api.loadProject(last).then((opened) => {
      if (opened !== undefined) void adopt(opened, api);
    });
  }, [adopt]);

  // The drag owns the document while a gesture is in flight, so the timeline renders its live preview
  // and the store records exactly one entry when the pointer is released.
  const drag = useClipDrag({ document, viewport, snapEnabled: snap, playhead, commit: commitDocument });

  const openProject = useCallback(async () => {
    const api = bridge();
    if (api === undefined) {
      setError('the desktop bridge is unavailable — this build is running outside Electron');
      return;
    }

    const opened = await api.openProject();
    if (opened === undefined) return;
    await adopt(opened, api);
  }, [adopt]);

  const save = useCallback(async () => {
    const api = bridge();
    if (api === undefined || project === undefined) return;
    await api.saveProject(saveDocument(store.getDocument()));
    store.markSaved();
    // The recovery file described work that is now on disk. Leaving it would make the next launch
    // offer to "recover" the file the user just saved.
    await autosave.clear();
  }, [autosave, project, store]);

  /**
   * Nudges the selected clip by a number of frames.
   *
   * The keyboard path to the same operation a drag performs, and the one that makes the rejection rule
   * visible: a move onto a neighbour is refused with its reason rather than resolved by displacing
   * material the user cannot see.
   */
  const nudge = useCallback(
    (delta: number) => {
      const target = [...selected][0];
      if (target === undefined) return;

      store.commit('move clip', (current) => {
        const located = locateClip(current, target as ClipId);
        if (located === undefined) return current;

        const result = moveClip(
          current,
          target as ClipId,
          TRACKS.video,
          frameIndex(Math.max(0, located.clip.span.start + delta)),
        );
        if (!result.ok) {
          setError(describeEdit(result.error));
          return current;
        }
        setError(undefined);
        return result.value;
      });
    },
    [selected, store],
  );

  /**
   * Lands an accepted variant on the timeline.
   *
   * The insertion rule lives in `@nos/editing` because it is a document transform, not a UI decision —
   * and it is two rules: a declared-length output lands where it was staged and reports a collision,
   * while a discovered-length one moves to a free track rather than shifting anything a user has cut.
   */
  const acceptVariant = useCallback(
    (outcome: SelectionOutcome, manifest: GeneratorManifest) => {
      if (outcome.kind !== 'accept') return;

      // A media-browser target means the output belongs in the project folder, not on the timeline —
      // it is already written to `generated/`, and the browser shows it. Inserting anyway would drop a
      // clip the user never asked to place, at whatever position happened to be under the playhead.
      if (outcome.target.kind !== 'timeline') {
        setError(undefined);
        tree.refresh();
        return;
      }

      const kind = manifest.produces === 'audio' ? 'audio' : 'video';
      const length = placeholderLength({
        manifest,
        params: {},
        frameRate: document.frameRate,
      });
      const target = outcome.target;

      store.commit('accept variant', (current) => {
        const result = insertGenerated(current, {
          asset: outcome.output.path,
          kind,
          sourceRate: current.frameRate,
          length: length.frames,
          at: target.at,
          track: target.track,
          duration: manifest.duration,
          id: clipId(`gen_${outcome.run}`),
          label: manifest.name,
          provenance: {
            generator: manifest.id,
            run: jobRunId(outcome.run),
            seed: outcome.seed,
            // A display-only timestamp, per the provenance contract: never used for ordering or cache
            // invalidation, so reading the clock here cannot affect a result.
            createdAt: new Date().toISOString(),
          },
        });

        if (!result.ok) {
          setError(describeEdit(result.error));
          return current;
        }
        setError(undefined);
        return result.value.document;
      });
    },
    [document.frameRate, store, tree],
  );

  const exportRun = useExportRun({ document, sidecar });
  const [exportSettings, setExportSettings] = useState<ExportSettings | undefined>(undefined);
  const [authoring, setAuthoring] = useState(false);

  const openExport = useCallback(() => {
    setExportSettings({
      // A conventional destination under `renders/`, per the project layout, so the common case needs
      // no typing at all.
      outputPath: `renders/${project?.name ?? 'sequence'}.mp4`,
      range: defaultRange(document),
      resolution: document.resolution,
      frameRate: document.frameRate,
      ...DEFAULT_EXPORT,
    });
  }, [document, project?.name]);

  /**
   * Adds a title at the playhead.
   *
   * On the text track, because that is where a title belongs and asking the user which track to put it
   * on is a question with one sensible answer.
   */
  const addText = useCallback(() => {
    store.commit('add title', (current) => {
      const track = current.sequence.tracks.find((entry) => entry.kind === 'text');
      if (track === undefined) return current;

      const id = `text_${playhead}_${track.clips.length + 1}`;
      const clip = createTextClip(id, playhead);
      const collides = track.clips.some(
        (entry) =>
          entry.span.start < clip.span.start + clip.span.duration &&
          clip.span.start < entry.span.start + entry.span.duration,
      );
      if (collides) {
        // Rejected rather than nudged: a title landing somewhere the user did not point at is worse
        // than one that does not appear, because the second is obvious and the first is not.
        setError('there is already a title at the playhead');
        return current;
      }

      setError(undefined);
      setSelected(new Set([id]));
      return {
        ...current,
        sequence: {
          ...current.sequence,
          tracks: current.sequence.tracks.map((entry) =>
            entry.id === track.id ? ({ ...entry, clips: [...entry.clips, clip] } as typeof entry) : entry,
          ),
        },
      };
    });
  }, [playhead, store]);

  // Measured from the same viewport the timeline draws with, so a waveform is rendered at the width it
  // is actually shown rather than at a guess.
  const widthForClip = useCallback(
    (clip: Clip) => Math.max(1, clip.span.duration / Math.max(0.0001, framesPerPixel)),
    [framesPerPixel],
  );
  const strips = useClipStrips({ document, sidecar, framesPerPixel, widthForClip });

  /**
   * The non-error status line.
   *
   * Two sources, one line: a mark that moved something the user did not touch, and a strip that could
   * not be derived. Neither is an error — the timeline still edits — but a silent one is found later,
   * as an export of the wrong length or a clip that stayed blank and read as a bug.
   */
  const notice =
    range.notice ??
    (strips.failures.length === 0
      ? undefined
      : strips.failures.length === 1
        ? `no strip for ${strips.failures[0]}`
        : `no strip for ${strips.failures.length} clips — ${strips.failures[0]}`);

  const mediaImport = useMediaImport({
    document,
    sidecar,
    videoTrack: TRACKS.video,
    audioTrack: TRACKS.audio,
    commit: commitDocument,
  });

  const razor = useCallback(() => {
    const target = [...selected][0];
    if (target === undefined) return;
    store.commit('split clip', (current) => {
      const result = splitClip(current, target as ClipId, playhead, `${target}_b` as ClipId);
      return result.ok ? result.value : current;
    });
  }, [playhead, selected, store]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--nos-bg-app)',
        color: 'var(--nos-text-primary)',
        font: '400 12px system-ui, sans-serif',
      }}
    >
      <TitleBar
        project={project}
        sidecar={sidecar}
        dirty={store.getSnapshot().dirty}
        transport={transport}
        frameRate={document.frameRate}
        jobs={runtime.snapshot.activeCount}
        onOpen={() => void openProject()}
        onSave={() => void save()}
        onExport={openExport}
        autosaveStatus={autosave.status}
      />

      {autosave.offer !== undefined && (
        <RecoveryOffer savedAt={autosave.offeredAt} onAccept={autosave.accept} onDiscard={autosave.discard} />
      )}

      {authoring && (
        <ManifestAuthoring
          graphs={library.graphs}
          onClose={() => setAuthoring(false)}
          onSaved={library.reload}
        />
      )}

      {exportSettings !== undefined && (
        <ExportDialog
          settings={exportSettings}
          {...(exportRun.progress !== undefined ? { progress: exportRun.progress } : {})}
          onChange={setExportSettings}
          onStart={() => exportRun.start(exportSettings)}
          onCancel={exportRun.cancel}
          onClose={() => setExportSettings(undefined)}
        />
      )}

      {exportRun.timing !== undefined && (
        <div
          role="status"
          style={{
            padding: '4px 16px',
            font: '500 11px ui-monospace, monospace',
            color: 'var(--nos-text-faint)',
          }}
        >
          {describeTiming(exportRun.timing)}
        </div>
      )}

      {(error ?? drag.rejection ?? exportRun.error ?? mediaImport.error) !== undefined && (
        <div
          role="alert"
          style={{
            padding: '6px 16px',
            background: 'rgba(255, 107, 107, 0.12)',
            color: 'var(--nos-danger)',
            font: '500 11px ui-monospace, monospace',
          }}
        >
          {error ?? drag.rejection ?? exportRun.error ?? mediaImport.error}
        </div>
      )}

      {notice !== undefined && (
        <div
          role="status"
          style={{
            padding: '6px 16px',
            background: 'rgba(255, 176, 32, 0.10)',
            color: 'var(--nos-warn)',
            font: '500 11px ui-monospace, monospace',
          }}
        >
          {notice}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <MediaBrowser
          tree={tree.tree ?? buildTree([])}
          watcher={tree.watcher}
          onRescan={tree.refresh}
          onActivate={(asset) => {
            void mediaImport.run(asset, playhead).then((id) => {
              // Selected on arrival, because the next thing a user does with a clip they just added is
              // almost always to it.
              if (id !== undefined) setSelected(new Set([id]));
            });
          }}
        />

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Preview document={drag.document} frame={playhead} sidecar={sidecar} />

          <div ref={laneRef} style={{ flex: 'none' }}>
            <Timeline
              document={drag.document}
              strips={strips.strips}
              onMarkIn={range.markIn}
              onMarkOut={range.markOut}
              onClearRange={range.clear}
              viewport={viewport}
              playhead={playhead}
              selectedClips={selected}
              snapEnabled={snap}
              rippleEnabled={ripple}
              onScrub={transport.seek}
              onSelectClip={(clip, additive) =>
                setSelected((current) => (additive ? new Set([...current, clip]) : new Set([clip as string])))
              }
              onClipPointerDown={(clip, event) => drag.begin('move', clip, event)}
              onTrimStart={(clip, event) => drag.begin('trim-start', clip, event)}
              onTrimEnd={(clip, event) => drag.begin('trim-end', clip, event)}
              onToggleSnap={() => setSnap((value) => !value)}
              onToggleRipple={() => setRipple((value) => !value)}
              onZoom={(next, anchorPx) => {
                setFramesPerPixel(next);
                setScrollFrame(frameIndex(Math.max(0, scrollFrame + anchorPx * (framesPerPixel - next))));
              }}
            />

            <KeyframeLanes
              document={drag.document}
              {...([...selected][0] !== undefined ? { clip: [...selected][0] } : {})}
              effects={effectRegistry}
              viewport={viewport}
              playhead={playhead}
              onChange={commitDocument}
            />
          </div>
        </main>

        <RightPanel
          document={document}
          effects={effectRegistry}
          onChangeDocument={commitDocument}
          registry={library.registry}
          libraryProblems={library.problems}
          runtime={runtime}
          playhead={playhead}
          selectedClip={[...selected][0]}
          canUndo={store.getSnapshot().canUndo}
          canRedo={store.getSnapshot().canRedo}
          onSplit={razor}
          onNudge={nudge}
          onAuthorManifest={() => setAuthoring(true)}
          onAcceptVariant={acceptVariant}
          onUndo={() => store.undo()}
          onRedo={() => store.redo()}
          onAddText={addText}
          onReject={setError}
        />
      </div>
    </div>
  );
}

function TitleBar({
  project,
  sidecar,
  dirty,
  transport,
  frameRate,
  jobs,
  onOpen,
  onSave,
  onExport,
  autosaveStatus,
}: {
  readonly project: ProjectInfo | undefined;
  readonly sidecar: SidecarInfo | undefined;
  readonly dirty: boolean;
  readonly transport: Transport;
  readonly frameRate: FrameRate;
  readonly jobs: number;
  readonly onOpen: () => void;
  readonly onSave: () => void;
  readonly onExport: () => void;
  readonly autosaveStatus: AutosaveStatus;
}): ReactNode {
  return (
    <header
      style={{
        height: 44,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        background: 'var(--nos-bg-panel)',
        borderBottom: '1px solid var(--nos-border)',
      }}
    >
      <span
        style={{
          font: '600 10px system-ui',
          letterSpacing: '.09em',
          textTransform: 'uppercase',
          color: 'var(--nos-text-dim)',
        }}
      >
        Necro Omni Studio
      </span>
      <span style={{ color: 'var(--nos-text-secondary)' }}>
        {project?.name ?? 'no project open'}
        {dirty ? ' •' : ''}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Button onClick={() => transport.step(-1)} title="Previous frame (←)">
          ◀
        </Button>
        <Button
          tone={transport.playing ? 'active' : 'default'}
          onClick={transport.toggle}
          title="Play or pause (space)"
        >
          {transport.playing ? 'Pause' : 'Play'}
        </Button>
        <Button onClick={() => transport.step(1)} title="Next frame (→)">
          ▶
        </Button>
        <span style={{ font: '600 13px ui-monospace, monospace', color: 'var(--nos-text-primary)' }}>
          {/* The core formatter, not a local one: it handles drop-frame, which is exactly the rule that
              is wrong in every hand-rolled timecode. */}
          {formatFrames(transport.frame, frameRate)}
        </span>
      </div>

      <div style={{ flex: 1 }} />
      {/* The spec's job chip: generation runs for minutes, and a user who cannot see that something is
          running assumes nothing happened and starts again. */}
      {jobs > 0 && (
        <span
          style={{
            font: '500 11px ui-monospace, monospace',
            color: 'var(--nos-generated-text)',
            background: 'rgba(155, 140, 255, 0.16)',
            borderRadius: 3,
            padding: '2px 6px',
          }}
        >
          {`${jobs} job${jobs === 1 ? '' : 's'}`}
        </span>
      )}
      {/* The sidecar's state is shown rather than hidden: without it there are no proxies, no
          waveforms and no export, and a user who cannot see that will blame the application. */}
      <span
        style={{
          font: '500 11px ui-monospace, monospace',
          color: sidecar?.available === true ? 'var(--nos-ok)' : 'var(--nos-warn)',
        }}
        title={sidecar?.detail ?? ''}
      >
        {sidecar === undefined ? 'sidecar idle' : sidecar.available ? 'sidecar ready' : 'sidecar unavailable'}
      </span>
      {project !== undefined && <AutosaveChip status={autosaveStatus} />}
      <Button onClick={onOpen}>Open project</Button>
      <Button onClick={onSave} disabled={project === undefined}>
        Save
      </Button>
      <Button tone="primary" onClick={onExport} disabled={project === undefined}>
        Export
      </Button>
    </header>
  );
}

/**
 * How stale the last recovery point is.
 *
 * It owns its own tick so that "autosaved 12s ago" keeps counting. A component of its own, rather
 * than a timer in the application root, because that timer would re-render the timeline, the preview
 * and the inspector once a second to update eleven characters.
 */
function AutosaveChip({ status }: { readonly status: AutosaveStatus }): ReactNode {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, []);

  return (
    <span
      style={{
        font: '500 11px ui-monospace, monospace',
        color: status.state === 'failed' ? 'var(--nos-danger)' : 'var(--nos-text-faint)',
      }}
      title="Autosave writes a recovery file beside the project; it never overwrites project.json"
    >
      {describeAutosave(status, now)}
    </span>
  );
}

/**
 * The offer to restore work from a session that did not exit cleanly.
 *
 * A banner rather than a modal, and neither choice is preselected. The user has to be able to look at
 * the timeline behind it to decide — "is this newer than what I have?" is not answerable from a
 * dialog that covers the answer. Nothing is deleted until they say so.
 */
function RecoveryOffer({
  savedAt,
  onAccept,
  onDiscard,
}: {
  readonly savedAt: number | undefined;
  readonly onAccept: () => void;
  readonly onDiscard: () => void;
}): ReactNode {
  return (
    <div
      role="alertdialog"
      aria-label="Unsaved work was recovered"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        background: 'rgba(255, 176, 32, 0.14)',
        color: 'var(--nos-warn)',
        font: '500 11px ui-monospace, monospace',
      }}
    >
      <span>
        unsaved work from {savedAt === undefined ? 'a previous session' : new Date(savedAt).toLocaleString()}{' '}
        was recovered
      </span>
      <div style={{ flex: 1 }} />
      <Button tone="primary" onClick={onAccept}>
        Restore it
      </Button>
      <Button onClick={onDiscard}>Discard</Button>
    </div>
  );
}

function describeEdit(error: { readonly kind: string }): string {
  return `the edit was rejected: ${error.kind.replace(/-/g, ' ')}`;
}

export { trimClipEnd, trimClipStart };
