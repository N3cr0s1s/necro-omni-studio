import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AssetPath,
  type AutosaveStatus,
  type Clip,
  type ClipId,
  type FrameRate,
  type TimelineDocument,
  type TrackId,
  type TrackKind,
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
import {
  type TrackFlag,
  addTrack,
  clipsInRegion,
  clipsOnTrack,
  combineSelection,
  firstTrackOfKind,
  insertGenerated,
  moveClip,
  nextTrackId,
  removeTrack,
  renameTrack,
  setTrackHeight,
  unlinkClips,
  toggleTrackFlag,
  trimClipEnd,
  trimClipStart,
} from '@nos/editing';
import { type GeneratorManifest, type SelectionOutcome, placeholderLength } from '@nos/generators';
import { Button, ContextMenu, ExportDialog, LevelMeter, MediaBrowser, Timeline } from '@nos/ui';
import { type ExportSettings, DEFAULT_EXPORT } from '@nos/export';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import type { DesktopBridge, ProjectInfo, SidecarInfo } from '../main/ipc-contract.js';
import type { MeterReading } from '@nos/audio';
import type { Transport } from './use-transport.js';
import { KeyframeLanes } from './KeyframeLanes.js';
import { ManifestAuthoring } from './ManifestAuthoring.js';
import { createTextClip } from './TextInspector.js';
import { Preview } from './Preview.js';
import { usePlaybackAudio } from './use-audio-engine.js';
import { useTransport, useTransportKeys } from './use-transport.js';
import { playbackEnd, useWorkRange } from './use-work-range.js';
import { describeAutosave, useAutosave } from './use-autosave.js';
import { useTheme } from './use-theme.js';
import { describeProxies, useProxies } from './use-proxies.js';
import { type ClipMenuAction, clipMenuItems } from './clip-menu.js';
import { describeRippleMode, useClipEdits } from './use-clip-edits.js';
import { useTimelineView } from './use-timeline-view.js';
import { useAssetDetail, useCacheListing } from './use-asset-detail.js';
import { useCacheStats } from './use-cache-stats.js';
import { BrowserDetail } from './BrowserDetail.js';
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
  const theme = useTheme();

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

  // The view follows the playhead while the transport runs, and owns the undo keys — both of which
  // were missing entirely: `scrollFrame` moved only as a side effect of zooming, so playback ran off
  // the right edge with the timeline sitting still.
  const view = useTimelineView({
    document,
    store,
    widthPx,
    playhead,
    playing: transport.playing,
  });
  const viewport = view.viewport;
  const framesPerPixel = viewport.framesPerPixel;

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
  const drag = useClipDrag({
    document,
    viewport,
    snapEnabled: snap,
    selected,
    playhead,
    commit: commitDocument,
  });

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

        // Onto the clip's *own* track. Nudging used to force everything to the first video track,
        // so nudging an audio clip was rejected for the wrong kind and nudging anything on a second
        // video track silently moved it up one.
        const result = moveClip(
          current,
          target as ClipId,
          located.track.id,
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
        // Said out loud. The file is already in `generated/` and the browser shows it, but a Keep that
        // produced no visible change is indistinguishable from a Keep that failed.
        setError(`kept — ${outcome.output.path} is in the project folder`);
        tree.refresh();
        return;
      }

      const kind = manifest.produces === 'audio' ? 'audio' : 'video';
      // The group's own parameters, not an empty set. A declared-length manifest reads its length from
      // one of them, so `{}` fell back to the manifest default — a user who asked for ten seconds got
      // fifty, with nothing on screen to explain it.
      const length = placeholderLength({
        manifest,
        params: outcome.params,
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
          // Keyed by the *candidate*, not the run: a batched run's variants share a run id, so
          // accepting the second would collide with the first and be refused — which is what "Keep
          // does nothing" looked like from the outside.
          id: clipId(`gen_${outcome.candidate.replace('#', '_')}`),
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

  // The spec's realtime preview target is "1080p/30 from proxy". The originals are decoded until each
  // proxy exists, so importing a 4K source shows a picture immediately and gets a cheaper one shortly.
  const proxies = useProxies({ document, sidecar });

  // The browser's footer. The cache size is re-read as proxies land, because a number that only
  // updated on relaunch would be wrong for exactly as long as it mattered.
  const [browserSelection, setBrowserSelection] = useState<AssetPath | undefined>(undefined);
  // One clip open at a time. Several would push the tracks below it off screen, and the lanes of two
  // clips on different tracks cannot be compared anyway — they are read against their own clip.
  const [expandedClip, setExpandedClip] = useState<ClipId | undefined>(undefined);
  /** Open while a track-resize drag is in flight, so the whole drag is one history entry. */
  const resizing = useRef(false);
  const [menu, setMenu] = useState<{ clip: ClipId | undefined; x: number; y: number } | undefined>(undefined);
  const cache = useCacheStats({ sidecar, revision: proxies.ready });
  // Listed rather than read off the browser's tree: the tree deliberately hides cache *contents*, so
  // its `cache` node has no children to inspect. Re-listed as derivations land and after a clear.
  const cacheEntries = useCacheListing(bridge(), project?.root, proxies.ready + cache.fileCount);
  const assetDetail = useAssetDetail({ asset: browserSelection, sidecar, cacheEntries });

  /**
   * The non-error status line.
   *
   * Two sources, one line: a mark that moved something the user did not touch, and a strip that could
   * not be derived. Neither is an error — the timeline still edits — but a silent one is found later,
   * as an export of the wrong length or a clip that stayed blank and read as a bug.
   */
  const notice =
    range.notice ??
    describeProxies(proxies) ??
    (strips.failures.length === 0
      ? undefined
      : strips.failures.length === 1
        ? `no strip for ${strips.failures[0]}`
        : `no strip for ${strips.failures.length} clips — ${strips.failures[0]}`);

  // Resolved from the document rather than assumed. Fixed ids were safe only while the track list
  // could not change; now that tracks can be added and removed, an import targeting a hard-coded `V1`
  // would fail on any project whose first video track was removed and remade.
  const mediaImport = useMediaImport({
    document,
    sidecar,
    videoTrack: firstTrackOfKind(document, 'video')?.id ?? TRACKS.video,
    audioTrack: firstTrackOfKind(document, 'audio')?.id ?? TRACKS.audio,
    commit: commitDocument,
  });

  const addTrackOfKind = useCallback(
    (kind: TrackKind) => {
      store.commit('add track', (current) => {
        const result = addTrack(current, { kind, id: nextTrackId(current, kind) });
        if (!result.ok) {
          setError(describeEdit(result.error));
          return current;
        }
        return result.value.document;
      });
    },
    [store],
  );

  const toggleTrack = useCallback(
    (id: TrackId, flag: TrackFlag) => {
      store.commit(`toggle track ${flag}`, (current) => {
        const result = toggleTrackFlag(current, id, flag);
        if (!result.ok) {
          setError(describeEdit(result.error));
          return current;
        }
        return result.value;
      });
    },
    [store],
  );

  const removeTrackById = useCallback(
    (id: TrackId) => {
      store.commit('remove track', (current) => {
        // Said before it happens, because the clips go with the track. Undo covers it, but a user who
        // did not realise what was on a collapsed row should not have to discover it by undoing.
        const lost = clipsOnTrack(current, id);
        const result = removeTrack(current, id);
        if (!result.ok) {
          setError(describeEdit(result.error));
          return current;
        }
        if (lost > 0) setError(`removed the track and ${lost} clip${lost === 1 ? '' : 's'} on it`);
        return result.value;
      });
    },
    [store],
  );

  // Every one of these has existed in the editing layer since M3 and none could be invoked: the
  // application could put clips on a timeline and never take one off.
  const clipEdits = useClipEdits({
    store,
    selected,
    playhead,
    ripple,
    onReject: setError,
    onRemoved: () => setSelected(new Set()),
    // Selected on arrival: what a user does immediately after pasting is act on the copy.
    onPasted: (clips) => setSelected(new Set(clips as readonly string[])),
    onSelect: (clips) => setSelected(new Set(clips as readonly string[])),
  });

  /**
   * Runs whatever the context menu chose.
   *
   * One switch rather than an item-carrying-a-callback list, so the menu stays a value: a description
   * of what is offered, which can be tested without rendering anything.
   */
  const runClipMenuAction = useCallback(
    (action: ClipMenuAction) => {
      switch (action) {
        case 'cut':
          clipEdits.cut();
          break;
        case 'copy':
          clipEdits.copy();
          break;
        case 'paste':
          clipEdits.paste();
          break;
        case 'duplicate':
          clipEdits.duplicate();
          break;
        case 'split':
          clipEdits.split();
          break;
        case 'toggle-enabled':
          clipEdits.toggleEnabled();
          break;
        case 'unlink':
          store.commit('unlink clips', (current) => {
            const target = menu?.clip;
            if (target === undefined) return current;
            const result = unlinkClips(current, target);
            if (!result.ok) {
              setError(describeEdit(result.error));
              return current;
            }
            return result.value;
          });
          break;
        case 'copy-attributes':
          clipEdits.copyAttributes();
          break;
        case 'paste-attributes':
          clipEdits.pasteAttributes();
          break;
        case 'remove':
          clipEdits.remove();
          break;
        default: {
          const unreachable: never = action;
          throw new Error(`Unhandled menu action ${String(unreachable)}`);
        }
      }
    },
    [clipEdits, menu, store],
  );

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
        jobs={runtime.snapshot.activeCount}
        onOpen={() => void openProject()}
        onSave={() => void save()}
        onExport={openExport}
        autosaveStatus={autosave.status}
        theme={theme.theme}
        onToggleTheme={theme.toggle}
      />

      {autosave.offer !== undefined && (
        <RecoveryOffer savedAt={autosave.offeredAt} onAccept={autosave.accept} onDiscard={autosave.discard} />
      )}

      {menu !== undefined && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={clipMenuItems({
            document,
            clip: menu.clip,
            selectionSize: selected.size,
            canPaste: clipEdits.canPaste,
            hasAttributes: clipEdits.attributeSummary !== undefined,
            ripple,
          })}
          onChoose={(action) => runClipMenuAction(action as ClipMenuAction)}
          onClose={() => setMenu(undefined)}
        />
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
          onReveal={() => void bridge()?.revealInFolder(exportSettings.outputPath)}
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
          {...(browserSelection !== undefined ? { selected: browserSelection } : {})}
          onSelect={setBrowserSelection}
          detail={<BrowserDetail asset={assetDetail} cache={cache} />}
          onActivate={(asset) => {
            void mediaImport.run(asset, playhead).then((id) => {
              // Selected on arrival, because the next thing a user does with a clip they just added is
              // almost always to it.
              if (id !== undefined) setSelected(new Set([id]));
            });
          }}
        />

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Preview
            document={drag.document}
            frame={playhead}
            sidecar={sidecar}
            resolveAsset={proxies.resolve}
          />

          {/* Under the picture it controls. In the title bar it sat among file and project actions,
              a hand's width from the frame a user is scrubbing and beside buttons that have nothing
              to do with playback. */}
          <Transport
            transport={transport}
            frameRate={document.frameRate}
            meters={audio.meters}
            onClearClip={audio.clearClip}
          />

          <div ref={laneRef} style={{ flex: 'none' }}>
            <Timeline
              document={drag.document}
              strips={strips.strips}
              onAddTrack={addTrackOfKind}
              onTrackRemove={removeTrackById}
              onTrackRename={(id, name) => {
                store.commit('rename track', (current) => {
                  const result = renameTrack(current, id, name);
                  if (!result.ok) {
                    setError(describeEdit(result.error));
                    return current;
                  }
                  return result.value;
                });
              }}
              onTrackResize={(id, height, phase) => {
                // One undo step for the whole drag, the rule every gesture here follows: the store's
                // gesture is opened on the first move and closed when the pointer comes up.
                if (!resizing.current) {
                  store.beginGesture('resize track');
                  resizing.current = true;
                }
                store.commit('resize track', (current) => {
                  const result = setTrackHeight(current, id, height);
                  return result.ok ? result.value : current;
                });
                if (phase === 'end') {
                  store.endGesture();
                  resizing.current = false;
                }
              }}
              onTrackMute={(id) => toggleTrack(id, 'muted')}
              onTrackSolo={(id) => toggleTrack(id, 'solo')}
              onTrackLock={(id) => toggleTrack(id, 'locked')}
              onMarkIn={range.markIn}
              onMarkOut={range.markOut}
              onClearRange={range.clear}
              {...(clipEdits.hasRange ? { onRemoveRange: clipEdits.removeRange } : {})}
              viewport={viewport}
              playhead={playhead}
              selectedClips={selected}
              snapEnabled={snap}
              rippleEnabled={ripple}
              onScrub={transport.seek}
              onSelectClip={(clip, additive) =>
                setSelected((current) => (additive ? new Set([...current, clip]) : new Set([clip as string])))
              }
              // A marquee reports frames and tracks; which clips that touches is the document's
              // question, answered in the editing layer rather than in the component.
              // Dropped material lands where it was dropped — which is the only reason to drag
              // rather than double-click, and what the browser's draggable rows had been promising.
              onDropAsset={(asset, track, frame) => {
                void mediaImport.run(asset as AssetPath, frame, track).then((id) => {
                  if (id !== undefined) setSelected(new Set([id]));
                });
              }}
              onContextMenu={(clip, x, y) => {
                // Right-clicking an unselected clip selects it first: acting on something other than
                // what was clicked is the one behaviour a context menu must never have.
                if (clip !== undefined && !selected.has(clip)) setSelected(new Set([clip as string]));
                setMenu({ clip, x, y });
              }}
              onSelectRegion={(region, additive) =>
                setSelected((current) => combineSelection(current, clipsInRegion(document, region), additive))
              }
              // Alt turns a move into a slip. The clip stays put and its content slides inside it —
              // the spec's csúsztatás, and the one edit whose result the clip's outline cannot show.
              onClipPointerDown={(clip, event) => drag.begin(event.altKey ? 'slip' : 'move', clip, event)}
              onTrimStart={(clip, event) => drag.begin('trim-start', clip, event)}
              onTrimEnd={(clip, event) => drag.begin('trim-end', clip, event)}
              {...(expandedClip !== undefined ? { expandedClip } : {})}
              onToggleExpandClip={(clip) =>
                setExpandedClip((current) => (current === clip ? undefined : clip))
              }
              lanes={
                expandedClip === undefined ? undefined : (
                  <KeyframeLanes
                    document={drag.document}
                    clip={expandedClip}
                    effects={effectRegistry}
                    viewport={viewport}
                    playhead={playhead}
                    onChange={commitDocument}
                  />
                )
              }
              {...(drag.snappedTo !== undefined
                ? { snapIndicator: { frame: drag.snappedTo.frame, kind: drag.snappedTo.kind } }
                : {})}
              onToggleSnap={() => setSnap((value) => !value)}
              onToggleRipple={() => setRipple((value) => !value)}
              onZoom={view.zoomAt}
              onScrollBy={view.scrollBy}
              onFit={view.fit}
            />
          </div>
        </main>

        <RightPanel
          projectTree={tree.tree}
          document={document}
          effects={effectRegistry}
          onChangeDocument={commitDocument}
          registry={library.registry}
          libraryProblems={library.problems}
          runtime={runtime}
          playhead={playhead}
          sidecar={sidecar}
          selectedClip={[...selected][0]}
          canUndo={store.getSnapshot().canUndo}
          canRedo={store.getSnapshot().canRedo}
          onSplit={clipEdits.split}
          onSplitAllTracks={clipEdits.splitAllTracks}
          onRemoveClip={clipEdits.remove}
          onToggleClipEnabled={clipEdits.toggleEnabled}
          onCopyAttributes={clipEdits.copyAttributes}
          onPasteAttributes={clipEdits.pasteAttributes}
          attributeSummary={clipEdits.attributeSummary}
          removeLabel={ripple ? 'Ripple delete' : 'Delete'}
          removeHint={`${describeRippleMode(ripple)} (Delete; hold shift for the other)`}
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
  jobs,
  onOpen,
  onSave,
  onExport,
  autosaveStatus,
  theme,
  onToggleTheme,
}: {
  readonly project: ProjectInfo | undefined;
  readonly sidecar: SidecarInfo | undefined;
  readonly dirty: boolean;
  readonly jobs: number;
  readonly onOpen: () => void;
  readonly onSave: () => void;
  readonly onExport: () => void;
  readonly autosaveStatus: AutosaveStatus;
  readonly theme: 'dark' | 'light';
  readonly onToggleTheme: () => void;
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
      {/* Named for what it switches to rather than what is on: a control labelled with the current
          state reads as a status, and a user has to guess whether pressing it changes anything. */}
      <Button
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </Button>
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
 * The transport.
 *
 * Its own strip directly under the preview, because that is what it controls. In the title bar it sat
 * among file and project actions — a hand's width from the frame being scrubbed, beside buttons that
 * have nothing to do with playback — and a user looking at the picture had to look away to move it.
 */
function Transport({
  transport,
  frameRate,
  meters,
  onClearClip,
}: {
  readonly transport: Transport;
  readonly frameRate: FrameRate;
  readonly meters: MeterReading | undefined;
  readonly onClearClip: () => void;
}): ReactNode {
  return (
    <div
      aria-label="Transport"
      style={{
        height: 'var(--nos-transport-height)',
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px',
        background: 'var(--nos-bg-panel)',
        borderTop: '1px solid var(--nos-border)',
        borderBottom: '1px solid var(--nos-border)',
      }}
    >
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

      <span style={{ font: 'var(--nos-text-readout)', color: 'var(--nos-text-primary)' }}>
        {/* The core formatter, not a local one: it handles drop-frame, which is exactly the rule that
            is wrong in every hand-rolled timecode. */}
        {formatFrames(transport.frame, frameRate)}
      </span>

      <div style={{ flex: 1 }} />

      {/* Beside the timecode, where an editor already looks during playback. A mix with no meter is a
          mix that can only be checked by exporting it and listening. */}
      <LevelMeter
        {...(meters?.peaks !== undefined ? { peaks: meters.peaks } : {})}
        clipped={meters?.clipped ?? false}
        onClearClip={onClearClip}
      />
    </div>
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
