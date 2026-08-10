import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AssetPath,
  type AutosaveStatus,
  type Clip,
  type ClipId,
  type EffectInstanceId,
  type FrameIndex,
  type HistoryStep,
  type JobGroupId,
  type FrameRate,
  type TimelineDocument,
  type TrackId,
  type TrackKind,
  FRAME_RATES,
  PROJECT_FOLDERS,
  createDocument,
  createDocumentStore,
  clipId,
  documentEnd,
  documentDuration,
  frameIndex,
  jobRunId,
  describeLoadError,
  loadDocument,
  locateClip,
  projectId,
  saveDocument,
  sequenceId,
  trackId,
  clipSource,
} from '@nos/core';
import { buildTree, formatBytes } from '@nos/media';
import {
  addTrack,
  clipsInRegion,
  clipsOnTrack,
  combineSelection,
  firstTrackOfKind,
  type InsertPlacement,
  type UnusedTakes,
  findUnusedTakes,
  insertGenerated,
  linkablePair,
  linkClips,
  canMoveTrack,
  moveTrack,
  nextTrackId,
  clipsPastTheirSource,
  describeSourceOverruns,
  removeMarker,
  removeTrack,
  renameTrack,
  setClipLabel,
  setTrackHeight,
  toggleTrackFlag,
  closeAllGaps,
  closeGapBefore,
  crossfadeAtCut,
  crossfadeSideFor,
  defaultCrossfadeFrames,
  maxCrossfadeAtCut,
  eligibleTracksFor,
  moveWithCrossfades,
  withLinkedClips,
  trimClipEnd,
  trimClipStart,
  unlinkClips,
  updateMarker,
  type TrackFlag,
  clipsUsing,
  relinkAsset,
  describeTransitionError,
  removeTransition,
} from '@nos/editing';
import {
  type GeneratorManifest,
  type RecalledRun,
  type SelectionOutcome,
  isProvenanceRecord,
  placeholderLength,
  provenancePath,
  recallRun,
  waitingTakes,
} from '@nos/generators';
import {
  ClapperboardIcon,
  FilmIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  FileJsonIcon,
  FolderPlusIcon,
  HistoryIcon,
  PauseIcon,
  PlayIcon,
  SaveIcon,
  ServerIcon,
  SkipBackIcon,
  KeyboardIcon,
  RedoIcon,
  TriangleAlertIcon,
  UndoIcon,
  SkipForwardIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nos/ui/components/ui/dialog';
import { Input } from '@nos/ui/components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@nos/ui/components/ui/resizable';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';
import { Separator } from '@nos/ui/components/ui/separator';
import { cn } from '@nos/ui/lib/utils';
import {
  type BrowserMenuTarget,
  type MenuBinding,
  menuBinding,
  type StatusNotice,
  type MarkerEdit,
  type TimelineMenuTarget,
  ExportDialog,
  ShortcutSheet,
  StatusBar,
  LevelMeter,
  MaskPointOverlay,
  MediaBrowser,
  TimecodeField,
  Timeline,
} from '@nos/ui';
import { type ExportSettings, DEFAULT_EXPORT } from '@nos/export';

import type { DesktopBridge, ProjectInfo, SidecarInfo } from '../main/ipc-contract.js';
import type { MeterReading } from '@nos/audio';
import type { Transport } from './use-transport.js';
import { useKeyframeLanes } from './KeyframeLanes.js';
import { ManifestAuthoring } from './ManifestAuthoring.js';
import { RecentProjects } from './RecentProjects.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@nos/ui/components/ui/dropdown-menu';
import { createTextClip } from './TextInspector.js';
import { Preview } from './Preview.js';
import { usePlaybackAudio } from './use-audio-engine.js';
import { useTransport, useTransportKeys } from './use-transport.js';
import { useModeKeys } from './use-mode-keys.js';
import { playbackEnd, playbackStart, useWorkRange } from './use-work-range.js';
import { describeAutosave, useAutosave } from './use-autosave.js';
import { WorkspaceTabs } from '@nos/ui';
import { EffectAuthoring } from './EffectAuthoring.js';
import { TextEditorTab } from './TextEditorTab.js';
import { StoryTab } from './StoryTab.js';
import { findTransition, useTransitionDrag } from './use-transition-drag.js';
import { actionFor, effectForShader } from './file-open.js';
import {
  type Workspace,
  type WorkspaceTabKind,
  activeTab,
  closeTab,
  descriptorFor,
  emptyWorkspace,
  focusTab,
  openTab,
  retitleTab,
} from './workspace.js';
import { ModeToggle } from './ModeToggle.js';
import { ThemePicker, useThemeAttribute } from './ThemePicker.js';
import {
  derivationActivity,
  exportActivity,
  generatorActivities,
  orderActivities,
  segmentationActivity,
} from './activities.js';
import { clipStartOf, maskIdForClip, sessionMaskSource } from './mask-source.js';
import { useStoredLayout } from './use-layout.js';
import type { MaskChoice } from './ClipInspector.js';
import { describeProxies, useProxies } from './use-proxies.js';
import { describeCacheStats, useDerivedCache } from './derived-cache.js';
import { useMediaDurations } from './use-media-durations.js';
import { useSourceBounds } from './use-source-bounds.js';
import { gpuStatusNote, useGpuStatus } from './use-gpu-status.js';
import { retryRequest } from './retry-generation.js';
import { allFiles, availabilityOf, describeAvailability, filesOnDisk, planImport } from '@nos/media';
import { RelinkDialog } from './RelinkDialog.js';
import { type ClipMenuAction, clipMenuItems } from './clip-menu.js';
import { describeRippleMode, useClipEdits } from './use-clip-edits.js';
import { useTimelineView } from './use-timeline-view.js';
import { type AssetDetail, useAssetDetail, useCacheListing } from './use-asset-detail.js';
import { useProvenanceWriter } from './use-provenance-writer.js';
import { useProjectFiles } from './use-project-files.js';
import { useMaskWorkspace } from './use-mask-workspace.js';
import { type BrowserMenuAction, browserMenuItems } from './browser-menu.js';
import { useCacheStats } from './use-cache-stats.js';
import { BrowserDetail } from './BrowserDetail.js';
import { useClipDrag } from './use-clip-drag.js';
import { useClipStrips } from './use-clip-strips.js';
import { useMediaImport } from './use-media-import.js';
import { defaultRange, describeTiming, useExportRun } from './use-export.js';
import { type PanelTab, RightPanel } from './RightPanel.js';
import { useGeneratorLibrary } from './use-generator-library.js';
import { useGeneratorRuntime } from './use-generator-runtime.js';
import { useProjectTree } from './use-project-tree.js';
import { describeEditError } from './edit-errors.js';
import { useEffectLibrary } from './use-effect-library.js';
import { useAppSettings } from './use-app-settings.js';
import { useConfirmation } from './use-confirmation.js';
import { SHORTCUT_GROUPS } from './shortcuts.js';
import { bridge } from './bridge.js';

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

/** The folder an entry sits in, or the project root. */
function parentFolder(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * Reads a project file, tolerating its absence.
 *
 * Module-level so its identity is stable: an inline arrow would be a new value every render, and the
 * effect that reads a provenance record would then re-read on each one.
 */
async function readText(path: string): Promise<string | undefined> {
  return bridge()
    ?.readTextFile(path)
    .catch(() => undefined);
}

/**
 * An accepted variant that is bound for the timeline.
 *
 * The accept case with its target narrowed to the one that has a track and a position. Written as a
 * type rather than checked again at each use, so a retry cannot be handed a media-browser outcome that
 * has nowhere to land.
 */
type AcceptOutcome = Extract<SelectionOutcome, { kind: 'accept' }>;
type AcceptedVariant = Omit<AcceptOutcome, 'target'> & {
  readonly target: Extract<AcceptOutcome['target'], { kind: 'timeline' }>;
};

/**
 * How much one keyboard zoom press changes the scale.
 *
 * A ratio rather than a fixed number of frames per pixel, so a press means the same thing whether the
 * sequence is framed whole or a single second fills the window.
 */
const ZOOM_STEP = 1.4;

export function App(): ReactNode {
  const [project, setProject] = useState<ProjectInfo | undefined>(undefined);
  const [sidecar, setSidecar] = useState<SidecarInfo | undefined>(undefined);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [snap, setSnap] = useState(true);
  // §6.2 asks for scrub audio, and scrub audio is also the first thing some editors turn off.
  const [scrubAudio, setScrubAudio] = useState(true);
  const [ripple, setRipple] = useState(false);
  const [widthPx, setWidthPx] = useState(1200);
  const [error, setError] = useState<string | undefined>(undefined);
  // Messages that say something worked, which have a different lifetime from ones that say it did not.
  const confirmation = useConfirmation();
  // Held in a ref so `adopt` can speak without taking the confirmation as a dependency: it is called
  // from a launch effect that must not re-run when an unrelated message changes.
  const confirmationRef = useRef<((message: string) => void) | undefined>(undefined);
  confirmationRef.current = confirmation.say;

  const store = useMemo(() => createDocumentStore(emptyProject('Untitled')), []);
  const [document, setDocument] = useState<TimelineDocument>(() => store.getDocument());
  useEffect(() => store.subscribe(() => setDocument(store.getDocument())), [store]);

  /*
   * How long each source is, which the trims have asked for since M2 and nobody supplied.
   *
   * Placed before the drag that uses it: without these bounds every trim ran unchecked, so an edge
   * could be dragged past the end of a shot and the refusal written for exactly that never fired.
   */
  const sourceBounds = useSourceBounds(document, sidecar);

  const audio = usePlaybackAudio({ document, sidecar });
  /*
   * Looping, per the mockups' `loop` beside the in and out points.
   *
   * A session preference rather than a document field: whether you are currently watching a cut over
   * and over is not a property of the cut, and it would be a strange thing to find in a `project.json`
   * a colleague opened.
   */
  const [looping, setLooping] = useState(false);
  const transport = useTransport({
    frameRate: document.frameRate,
    ...(looping ? { loopFrom: playbackStart(document) } : {}),
    // Playback stops at the out point when one is marked. The range is the spec's bound on looped
    // playback as well as the export default, and honouring it in only one of the two would make the
    // preview disagree with the file it is supposed to be previewing.
    endFrame: playbackEnd(document, documentEnd(document)),
    audio,
  });
  useTransportKeys(transport);

  /*
   * The mode switches, which had no keys — and Snap's tooltip claimed one.
   *
   * Declared as a map so a fourth mode is an entry here and a row in the sheet, rather than another
   * listener competing for the window.
   */
  useModeKeys(
    useMemo(
      () => ({
        n: () => setSnap((value) => !value),
        r: () => setRipple((value) => !value),
        l: () => setLooping((value) => !value),
      }),
      [],
    ),
  );
  const playhead = transport.frame;

  // Autosave writes a recovery *sibling*, never `project.json`: an autosave that overwrote the file
  // would destroy the last state the user deliberately saved, the moment they started experimenting.
  const autosave = useAutosave({ store, projectRoot: project?.root, bridge: bridge() });

  const tree = useProjectTree(project?.root);
  // The runtime probes ComfyUI once and reports which backend is actually in use; the registry then
  // validates `requires` against the node classes that probe returned, so an unavailable generator is
  // greyed for the real reason rather than because the backend was still starting.
  const graphsRef = useRef<ReadonlyMap<string, unknown> | undefined>(undefined);
  const appSettings = useAppSettings();
  // Stamped on `<html>` from the stored setting, so the palette applies as soon as it is known rather
  // than only when the picker is used.
  useThemeAttribute(appSettings.settings?.theme);
  const runtime = useGeneratorRuntime({
    graphs: graphsRef,
    projectRoot: project?.root,
    variantMaximum: appSettings.settings?.variantMaximum,
    backendUrl: appSettings.settings?.backendUrl,
  });
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
  // The builtins plus whatever the project's `effects/` folder holds, which §4 reserves for exactly
  // that and which nothing read until now.
  const effects = useEffectLibrary(project?.root);
  const effectRegistry = effects.registry;

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
    selected,
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
  /**
   * A project this shell could not read, held so it can be explained rather than merely refused.
   *
   * Its own state and not the shared notice stream: notices are cleared by the next successful edit,
   * and this one has to survive until the user has done something about it.
   */
  const [unreadable, setUnreadable] = useState<
    { readonly root: string; readonly name: string; readonly reason: string } | undefined
  >(undefined);

  const adopt = useCallback(
    async (opened: ProjectInfo, api: DesktopBridge) => {
      /*
       * The document is read *before* anything switches, and this order is the whole point.
       *
       * It used to switch first and read second, so a `project.json` that failed to parse left the
       * editor showing the previous project's timeline — or an empty one on launch — under the new
       * project's name, with Save enabled. Pressing it wrote that document into the folder, and the
       * broken-but-repairable file the user could still have fixed by hand became an empty `Untitled`
       * project. Verified against the running application before it was changed: the header claimed
       * the project was open, Save was offered, and one click destroyed it.
       *
       * So a project that cannot be read never becomes the open project. Nothing switches, the
       * previous project stays exactly as it was, and the reason is kept where it can be shown.
       */
      let next: TimelineDocument;
      let upgraded: readonly string[] = [];

      if (opened.document === undefined) {
        // A folder with no `project.json` is a *new* project, not a broken one.
        next = emptyProject(opened.name);
      } else {
        const loaded = loadDocument(opened.document);
        if (!loaded.ok) {
          // The describer names the offending path, for the same reason the spec makes a broken
          // manifest name its broken pointer. Throwing that away and saying "could not be read" left
          // the user with a file to fix and nothing to fix it by.
          setUnreadable({
            root: opened.root,
            name: opened.name,
            reason: describeLoadError(loaded.error),
          });
          return;
        }
        next = loaded.value.document;
        upgraded = loaded.value.migrationsApplied;
      }

      setUnreadable(undefined);
      setProject(opened);
      setSidecar(await api.sidecarInfo());
      store.reset(next);
      setError(undefined);

      if (upgraded.length > 0) {
        /*
         * `migrationsApplied` is documented as existing "so the UI can say the project was upgraded",
         * and nothing read it. It cannot fire yet — `MIGRATIONS` is empty at schema version 1 — so
         * this is a seam wired ahead of the first migration rather than a bug being closed, and it is
         * said plainly because a path that has never run is exactly what this codebase keeps finding.
         *
         * It is worth wiring now because the consequence is on the way *out*: the next save writes the
         * current schema, which an older build will no longer open, and that should not be a silent
         * result of double-clicking a file.
         */
        confirmationRef.current?.(`${opened.name} was upgraded — ${upgraded.join(', ')}`);
      }
    },
    [store],
  );

  /**
   * The sidecar settling, after the project has already opened.
   *
   * Opening no longer waits for it — starting it takes up to fifteen seconds, and a project is fully
   * editable without one — so the state that was read once at adoption has to be *heard about* when it
   * changes, or the badge would say "starting" for the rest of the session.
   */
  useEffect(() => bridge()?.onSidecarStatus(setSidecar), []);

  // Reopens the last project on launch. An editor that forgets what you were working on every time it
  // starts is one the user has to navigate a folder picker to use at all.
  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;

    // Asked of the shell rather than read from `localStorage`, which on a `file://` origin Chromium
    // does not guarantee to persist — so this used to work on some launches and not others, which is
    // the one behaviour a "reopen what I was working on" feature must not have.
    void api.lastProject().then((last) => {
      if (last === undefined || last === '') return;
      // A folder that has been moved, renamed or unplugged simply does not open. Reporting it would
      // greet the user with an error about a decision they made weeks ago.
      return api.loadProject(last).then((opened) => {
        if (opened !== undefined) void adopt(opened, api);
      });
    });
  }, [adopt]);

  // The drag owns the document while a gesture is in flight, so the timeline renders its live preview
  // and the store records exactly one entry when the pointer is released.
  const drag = useClipDrag({
    sources: sourceBounds.resolver,
    document,
    viewport,
    snapEnabled: snap,
    selected,
    playhead,
    commit: commitDocument,
  });

  /*
   * Bumped whenever a project opens, so the reopen list picks up the new order.
   *
   * A counter rather than the project: the list needs to know that *something* changed, and taking the
   * project would make it re-read on every field of it that happens to differ.
   */
  const [openedCount, setOpenedCount] = useState(0);

  const openProject = useCallback(async () => {
    const api = bridge();
    if (api === undefined) {
      setError('the desktop bridge is unavailable — this build is running outside Electron');
      return;
    }

    const opened = await api.openProject();
    if (opened === undefined) return;
    await adopt(opened, api);
    setOpenedCount((count) => count + 1);
  }, [adopt]);

  /**
   * Opens a remembered project by path, skipping the picker.
   *
   * A folder that has gone since simply does not open, and the list already says which those are — so
   * there is nothing to report here that the row has not said. Reporting it anyway would be an error
   * dialog about a decision the user made weeks ago.
   */
  const openProjectAt = useCallback(
    async (root: string) => {
      const api = bridge();
      if (api === undefined) return;

      const opened = await api.loadProject(root);
      if (opened === undefined) return;
      await adopt(opened, api);
      setOpenedCount((count) => count + 1);
    },
    [adopt],
  );

  /*
   * The shell needs to know whether there is unsaved work *before* the user tries to close, because a
   * question asked at close time races the window's teardown — and a stale answer means either a lost
   * edit or a prompt nobody can explain.
   */
  const unsaved = store.getSnapshot().dirty;
  useEffect(() => {
    void bridge()?.setUnsaved(unsaved && project !== undefined);
  }, [unsaved, project]);

  const save = useCallback(async () => {
    const api = bridge();
    if (api === undefined || project === undefined) return;
    await api.saveProject(saveDocument(store.getDocument()));
    store.markSaved();
    // The recovery file described work that is now on disk. Leaving it would make the next launch
    // offer to "recover" the file the user just saved.
    await autosave.clear();
  }, [autosave, project, store]);

  /*
   * Saving because the window is closing, then closing it.
   *
   * The renderer closes rather than the shell, so a slow write cannot be overtaken by the close it was
   * meant to precede — an editor that saved *while* quitting would be a data-loss bug wearing the
   * costume of a fix.
   */
  useEffect(
    () =>
      bridge()?.onSaveBeforeClose(() => {
        void save().finally(() => void bridge()?.closeWindow());
      }),
    [save],
  );

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

        /*
         * The same operation the drag uses, on the clip's own track.
         *
         * Two rules meet here and only one of them used to. Nudging once forced everything onto the
         * first video track, so an audio clip was rejected for the wrong kind and anything on a
         * second video row silently moved up one — hence the clip's own track.
         *
         * And it goes through the crossfade path because a drag does. Without that, a clip that is
         * *already* crossfaded with its neighbour cannot be nudged at all: it overlaps, every move is
         * a collision, and the arrow keys stop working on exactly the clips a user has just finished
         * joining. Found by the smoke harness, which nudges a clip after the crossfade section and
         * got nothing — a keyboard that refuses what the pointer allows is two behaviours for one
         * edit.
         */
        const result = moveWithCrossfades({
          document: current,
          ids: withLinkedClips(current, [target as ClipId]),
          deltaFrames: delta,
          deltaRows: 0,
          eligibleTracks: (clip) => eligibleTracksFor(current.sequence.tracks, clip),
        });
        if (!result.ok) {
          setError(describeEditError(result.error));
          return current;
        }
        setError(undefined);
        return result.value.document;
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
   *
   * The placement is passed in rather than left to the rule, because the collision it reports is a
   * question. Answering it is this layer's job: the rule says what happened, the status bar offers the
   * way out, and the retry comes back through here with the same outcome and a different placement.
   */
  /**
   * A variant the user kept, that could not go where it was staged.
   *
   * Held so the collision can be *offered* rather than only reported. Keeping the whole outcome means
   * the retry is the same call with one argument changed, instead of a second insertion path that
   * would drift from this one.
   */
  const [blocked, setBlocked] = useState<
    | {
        readonly outcome: AcceptedVariant;
        readonly manifest: GeneratorManifest;
        readonly track: TrackId;
      }
    | undefined
  >(undefined);

  const landVariant = useCallback(
    (outcome: AcceptedVariant, manifest: GeneratorManifest, placement: InsertPlacement) => {
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
          placement,
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
          // A collision is the one rejection the user can answer, so it is offered as a choice rather
          // than reported as a failure. Everything else is a plain error.
          if (result.error.kind === 'collision' && placement === 'staged') {
            setBlocked({ outcome, manifest, track: result.error.track });
          } else {
            setError(describeEditError(result.error));
          }
          return current;
        }

        setBlocked(undefined);
        setError(undefined);
        if (result.value.createdTrack) {
          // Said out loud, because a track appearing is a change to the project the user did not
          // literally ask for and would otherwise have to notice on their own.
          confirmation.say(`kept — ${manifest.name} went to a new track, ${result.value.track}`);
        }
        return result.value.document;
      });
    },
    [confirmation, document.frameRate, store],
  );

  const acceptVariant = useCallback(
    (outcome: SelectionOutcome, manifest: GeneratorManifest) => {
      if (outcome.kind !== 'accept') return;

      // The group has been answered whichever way the take is used, so the tab stops advertising it.
      // The picker is untouched: keeping a second take from the same batch still works.
      runtime.answerGroup(outcome.group);

      // A media-browser target means the output belongs in the project folder, not on the timeline —
      // it is already written to `generated/`, and the browser shows it. Inserting anyway would drop a
      // clip the user never asked to place, at whatever position happened to be under the playhead.
      if (outcome.target.kind !== 'timeline') {
        // Said out loud. The file is already in `generated/` and the browser shows it, but a Keep that
        // produced no visible change is indistinguishable from a Keep that failed.
        confirmation.say(`kept — ${outcome.output.path} is in the project folder`);
        tree.refresh();
        return;
      }

      landVariant({ ...outcome, target: outcome.target }, manifest, 'staged');
    },
    [confirmation, landVariant, runtime, tree],
  );

  /**
   * Which clip's name field should open by itself, for a rename asked for from the timeline's menu.
   *
   * The clip rather than a flag. A boolean stays true after the field closes, so selecting the next
   * clip would open *its* name field uninvited — the rename would follow the user around. Naming the
   * clip makes the offer expire the moment the selection moves, with nothing to clear.
   */
  const [renamingClip, setRenamingClip] = useState<ClipId | undefined>(undefined);
  /** The clip whose media the user is repointing, and therefore which dialog is open. */
  const [relinking, setRelinking] = useState<ClipId | undefined>(undefined);

  /**
   * Renames a clip.
   *
   * The capability existed in `@nos/editing` from the start and nothing called it: a clip's label is
   * drawn on the timeline, in the inspector and in every menu, and it could only ever be whatever the
   * import or the generator chose. Three kept variants of one generator arrive with one name between
   * them.
   */
  const renameClip = useCallback(
    (clip: ClipId, name: string) => {
      setRenamingClip(undefined);
      store.commit('rename clip', (current) => {
        const result = setClipLabel(current, clip, name);
        if (!result.ok) {
          setError(describeEditError(result.error));
          return current;
        }
        setError(undefined);
        return result.value;
      });
    },
    [store],
  );

  /**
   * Naming and colouring a marker.
   *
   * The capability was in the document model from the start — `Marker.label` and `Marker.color`, both
   * drawn by the ruler and both round-tripped by `project.json` — and nothing could set either. Every
   * marker was named after its own timecode, the one fact the ruler it sits on already states.
   */
  const editMarker = useCallback(
    (frame: FrameIndex, change: MarkerEdit) => {
      store.commit('edit marker', (current) => {
        const result = updateMarker(current, frame, change);
        if (!result.ok) {
          setError(describeEditError(result.error));
          return current;
        }
        setError(undefined);
        return result.value;
      });
    },
    [store],
  );

  const removeMarkerAt = useCallback(
    (frame: FrameIndex) => {
      store.commit('remove marker', (current) => removeMarker(current, frame));
    },
    [store],
  );

  // Held in a ref so the listener above is attached once rather than re-bound on every document change.
  const saveRef = useRef(save);
  saveRef.current = save;

  const [exportSettings, setExportSettings] = useState<ExportSettings | undefined>(undefined);
  const [authoring, setAuthoring] = useState(false);
  /**
   * The effect editor, per issue #28. An object rather than a boolean so it can carry which effect is
   * being edited — `{}` is a new one, `{ editing: id }` is an existing one.
   */
  /**
   * What the window is showing, per issue #31.
   *
   * The editor is a tab rather than the whole window, so anything else — a shader, a file — opens
   * *beside* the cut rather than over it. The effect editor used to cover everything, and the only
   * way back to the timeline was to close it.
   */
  const [workspace, setWorkspace] = useState<Workspace>(() => emptyWorkspace());
  const showing = activeTab(workspace);

  /*
   * The project's *own* effects, with the shader each one is.
   *
   * Builtins are deliberately excluded. A project effect declaring a builtin's id shadows it, and the
   * library documents that as the useful direction — a shipped effect is a starting point. Warning
   * that saving "replaces" one would be telling the user off for the intended behaviour.
   */
  const projectEffects = useMemo(() => {
    const local = new Set(
      effects.local.map((raw) => String((raw.json as { readonly id?: unknown }).id ?? '')),
    );
    return effects.registry
      .available()
      .filter((entry) => local.has(entry.id as string))
      .map((entry) => ({ manifest: entry.manifest, shader: entry.source.source }));
  }, [effects.local, effects.registry]);

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
  /*
   * The derived cache's size, so the browser can offer to reclaim it.
   *
   * §4 is the only place in the spec that calls a project folder disposable, and the sidecar has been
   * able to report and empty it all along with nothing asking.
   */
  const derivedCache = useDerivedCache(sidecar);

  /*
   * How long each piece of media is, for the browser's rows.
   *
   * Probed after the tree rather than with it: a duration lives in the container, so folding it into
   * the walk would make opening a project wait on an ffprobe of every asset in it.
   */
  const mediaDurations = useMediaDurations(tree.tree, sidecar);

  /*
   * What the one GPU is doing, per §7's semaphore and mockup 1e's "shown, not hidden".
   *
   * Serialization has worked since the queue was written; only its state was invisible, so a
   * generation that was waiting on a mask propagation looked like one that had stopped.
   */
  const gpuNote = gpuStatusNote(useGpuStatus(runtime.gpu));

  /** One line about any clip that asks for more material than its source holds. */
  const overrunNote = useMemo(
    () => describeSourceOverruns(clipsPastTheirSource(document, sourceBounds.resolver)),
    [document, sourceBounds.resolver],
  );

  // The browser's footer. The cache size is re-read as proxies land, because a number that only
  // updated on relaunch would be wrong for exactly as long as it mattered.
  const [browserSelection, setBrowserSelection] = useState<AssetPath | undefined>(undefined);
  // One clip open at a time. Several would push the tracks below it off screen, and the lanes of two
  // clips on different tracks cannot be compared anyway — they are read against their own clip.
  const [expandedClip, setExpandedClip] = useState<ClipId | undefined>(undefined);
  // Fed the drag's document so a lane's markers travel with the clip they belong to during a gesture,
  // and read as rows rather than as markup so the header column can name each one beside it.
  const keyframes = useKeyframeLanes({
    document: drag.document,
    ...(expandedClip !== undefined ? { clip: expandedClip } : {}),
    effects: effectRegistry,
    viewport,
    playhead,
    onChange: commitDocument,
  });

  /*
   * Undo and redo, and what each would take back.
   *
   * Read from the snapshot rather than kept beside it: the store is the single mutation point, so its
   * own account of the history is the only one that cannot fall behind. The labels have been recorded
   * since M1 and surfaced on `StoreSnapshot` just as long, and until now nothing read them.
   */
  const historySnapshot = store.getSnapshot();
  const history = useMemo<HistoryControls>(
    () => ({
      canUndo: historySnapshot.canUndo,
      canRedo: historySnapshot.canRedo,
      undoLabel: historySnapshot.undoLabel,
      redoLabel: historySnapshot.redoLabel,
      steps: historySnapshot.steps,
      undo: () => store.undo(),
      redo: () => store.redo(),
      jump: (offset: number) => store.jump(offset),
    }),
    [
      store,
      historySnapshot.canUndo,
      historySnapshot.canRedo,
      historySnapshot.undoLabel,
      historySnapshot.redoLabel,
      historySnapshot.steps,
    ],
  );

  /** Open while a track-resize drag is in flight, so the whole drag is one history entry. */
  const resizing = useRef(false);
  // Which track's name field is open. Cleared by the rename itself, so the menu and a double-click
  // both end in the same place.
  const [renamingTrack, setRenamingTrack] = useState<TrackId | undefined>(undefined);
  /**
   * Moving the playhead, audibly.
   *
   * The engine has been able to play a short grain at a frame since it was written — `scrub` is on its
   * interface and on this hook's — and nothing ever called it, so dragging the playhead was silent and
   * §6.2's "audio mix **and scrub**" was half implemented.
   *
   * Not while playing. The engine stops playback to make room for a grain, which is right when the
   * transport is parked and wrong when it is running: a click on the ruler mid-playback should move
   * the play position, not replace the sound with a blip.
   */
  const scrubTo = useCallback(
    (frame: FrameIndex) => {
      transport.seek(frame);
      if (scrubAudio && !transport.playing) audio.scrub(frame);
    },
    [audio, scrubAudio, transport],
  );

  /**
   * A generated file's settings, loaded back into the generator panel.
   *
   * The provenance contract records the generator, the preset, the seed and every parameter *so that*
   * a result can be reproduced — and all of it could only be read. A seed you cannot feed back is a
   * receipt rather than a tool.
   *
   * A new object per recall even when the values are identical, because the panel applies it on
   * change: recalling the same take twice has to land twice.
   */
  const [recalled, setRecalled] = useState<RecalledRun | undefined>(undefined);

  const recallGeneration = useCallback(
    (asset: AssetDetail, reproduce: boolean) => {
      const record = asset.provenance;
      const manifest = library.registry?.manifestFor(record?.generator as never);
      if (record === undefined || manifest === undefined) {
        // Said rather than ignored: the generator that made this file is no longer installed, and a
        // button that did nothing would read as a broken button rather than a missing manifest.
        setError(`${record?.generatorName ?? 'that generator'} is not installed any more`);
        return;
      }

      const run = recallRun({ provenance: record, manifest, reproduce });
      setRecalled(run);
      setRightTab('generate');

      confirmation.say(
        run.dropped.length === 0
          ? `loaded ${record.generatorName}${reproduce ? ` at seed ${String(record.seed)}` : ''}`
          : // Named, because a recall that quietly dropped three settings would set up a run that is
            // not the one the user pointed at.
            `loaded ${record.generatorName} — ${run.dropped.join(', ')} no longer exist`,
      );
    },
    [confirmation, library.registry],
  );

  /**
   * Generated takes nothing is using, once the user has been told what they are.
   *
   * Held rather than acted on, because this is the one action in the browser that touches many files
   * at once. It goes to the trash like every other removal here — so it is recoverable — but a user
   * who is offered "remove unused takes" and gets no count deserves to be suspicious of it.
   */
  const [prune, setPrune] = useState<UnusedTakes | undefined>(undefined);

  const proposePrune = useCallback(async () => {
    /*
     * Eligibility is decided here, not in `findUnusedTakes`: only the shell can read a folder, and the
     * rule is deliberately narrow. A file counts as a take only if it sits directly under `generated/`
     * **and** has a provenance record beside it — which is to say only if a generator in this
     * application wrote it. Anything a user dropped into that folder by hand is left alone.
     *
     * Read from the folder rather than from the browser's tree, which is what the first attempt did
     * and why it found nothing: the tree hides `.nos.json` deliberately — showing it would double the
     * length of `generated/` with rows nobody can act on — so the very evidence this rule needs is
     * exactly what the tree drops.
     */
    const entries = await bridge()?.listFolder(PROJECT_FOLDERS.generated);
    if (entries === undefined) return;

    const records = new Set(entries.filter((entry) => isProvenanceRecord(entry.path)).map((e) => e.path));
    const candidates = entries
      .filter((entry) => entry.kind === 'file' && !isProvenanceRecord(entry.path))
      .filter((entry) => records.has(provenancePath(entry.path)))
      // A size the listing did not report counts as zero rather than dropping the take: the file is
      // still unused and still worth removing, and the total simply understates what is reclaimed.
      .map((entry) => ({ path: entry.path as AssetPath, sizeBytes: entry.sizeBytes ?? 0 }));

    const found = findUnusedTakes(document, candidates);
    if (found.unused.length === 0) {
      confirmation.say(
        candidates.length === 0
          ? 'there are no generated takes to remove'
          : `every one of the ${candidates.length} takes is in use`,
      );
      return;
    }
    setPrune(found);
  }, [confirmation, document]);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /*
   * `Ctrl+S` saves, which every editor binds and this one did not.
   *
   * Autosave and the toolbar button both existed, so nothing was ever *lost* — but a user who has just
   * made a change they care about presses this, and a key that does nothing teaches them the work is
   * not safe. It is also what the browser would otherwise take for "save this page".
   */
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      // Not guarded against text fields: a title being typed is exactly when someone reaches for this.
      event.preventDefault();
      void saveRef.current();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /*
   * `?` opens the reference, which is where every application that has one puts it.
   *
   * Ignored while a text field has focus, exactly like every other binding in the shell — a question
   * mark typed into a prompt is a question mark, not a request for help.
   */
  /*
   * The three staples of a keyboard-driven timeline that had no binding at all.
   *
   * `nudge` existed and was reachable only from the inspector's buttons, which is the slowest possible
   * way to move a clip one frame; the sequence had a Home and no End; and zoom could be reached by a
   * wheel or by Fit, but not by the keys every editor uses for it.
   *
   * Held apart from the transport's own handler because these need the document and the viewport, and
   * threading either into the transport would make it something other than a transport.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      switch (event.key) {
        case 'End':
          // The last frame, not one past it: the playhead sits *on* frames, and parking it beyond the
          // end shows black and reports a frame the sequence does not have.
          transport.seek(frameIndex(Math.max(0, documentEnd(document) - 1)));
          break;
        case ',':
          nudge(-1);
          break;
        case '.':
          nudge(1);
          break;
        case '=':
        case '+':
          view.zoomBy(1 / ZOOM_STEP);
          break;
        case '-':
          view.zoomBy(ZOOM_STEP);
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [document, nudge, transport, view]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      setShortcutsOpen(true);
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // Whether the inspector's name field should open by itself, for a rename asked for from the timeline.
  const columns = useStoredLayout('nos.layout.columns');
  const rows = useStoredLayout('nos.layout.rows');
  const cache = useCacheStats({ sidecar, revision: proxies.ready });
  // Listed rather than read off the browser's tree: the tree deliberately hides cache *contents*, so
  // its `cache` node has no children to inspect. Re-listed as derivations land and after a clear.
  const cacheEntries = useCacheListing(bridge(), project?.root, proxies.ready + cache.fileCount);
  const assetDetail = useAssetDetail({ asset: browserSelection, sidecar, cacheEntries, readText });

  // Every generated file gets a record beside it, including the variants that were looked at and
  // discarded — those stay on disk, and leaving them unlabelled would leave the folder full of
  // exactly the anonymous files this exists to prevent.
  useProvenanceWriter(runtime.snapshot, library.registry, bridge);

  const files = useProjectFiles(bridge);

  /**
   * Brings chosen files into a folder of the project.
   *
   * Shared by the menu entry and the drag from outside, because they differ only in how the paths were
   * chosen — and two routes that copied files by different rules would eventually name them by
   * different rules too.
   */
  const importInto = useCallback(
    async (sources: readonly string[], into: string) => {
      const api = bridge();
      if (api === undefined || sources.length === 0) return;

      const taken = new Set(
        (tree.tree === undefined ? [] : allFiles(tree.tree))
          .filter((file) => file.path.startsWith(`${into}/`))
          .map((file) => file.name),
      );
      const landed = await api.copyIntoProject(planImport(sources, into, taken));

      tree.refresh();
      if (landed.length === sources.length) {
        confirmation.say(
          landed.length === 1 ? `imported ${landed[0]}` : `imported ${landed.length} files into ${into}`,
        );
      } else {
        // Said rather than swallowed: a partial import that reported success would leave the user
        // believing material is there.
        setError(`imported ${landed.length} of ${sources.length} files — the rest could not be read`);
      }
    },
    [confirmation, tree],
  );

  const runPrune = useCallback(async () => {
    const found = prune;
    setPrune(undefined);
    if (found === undefined) return;

    let removed = 0;
    for (const take of found.unused) {
      // The record goes with its take. Leaving it would make the folder look like it still holds a
      // file that is no longer there, and the next prune would count it as a take with no asset.
      if (await files.trash(take.path)) removed += 1;
      await files.trash(provenancePath(take.path));
    }

    tree.refresh();
    confirmation.say(`moved ${removed} unused take${removed === 1 ? '' : 's'} to the trash`);
  }, [confirmation, files, prune, tree]);

  // Held here because the points are placed on the preview and the run is started in the inspector,
  // and those are siblings — a session owned by either could not be drawn by the other.
  // Owned here, not mirrored: the shell switches it — a clip rename opens the inspector, a recall
  // opens the generate panel — and a copy it could only read made both of those silently do nothing.
  const [rightTab, setRightTab] = useState<PanelTab>('clip');

  /*
   * Saying once that takes have landed.
   *
   * Found by running a real generation and reading every word: three takes arrived in twelve seconds
   * and the application said nothing at all. The generate panel was unchanged — same "ready", same
   * "Generate 3 variants" — the tab holding them read `Variants` either way, and the status bar said
   * "Idle". The obvious next action was to press Generate again.
   *
   * The tab now carries a count, which is the standing signal; this is the moment one. It fires on the
   * *transition* to having takes rather than on every render that has some, so it says it once and
   * does not nag while the user is deciding.
   *
   * A sentence and not a tab switch: moving the panel under someone mid-edit is worse than the silence.
   */
  const takesWaiting = useMemo(
    () => waitingTakes(runtime.snapshot, library.registry, runtime.answeredGroups),
    [runtime.snapshot, library.registry, runtime.answeredGroups],
  );
  const announcedTakes = useRef(0);
  useEffect(() => {
    const previous = announcedTakes.current;
    announcedTakes.current = takesWaiting;
    if (takesWaiting > previous && previous === 0) {
      confirmationRef.current?.(
        `${takesWaiting} take${takesWaiting === 1 ? '' : 's'} ready — pick one in Variants`,
      );
    }
  }, [takesWaiting]);
  const selectedClip = [...selected][0];
  const masks = useMaskWorkspace(document, selectedClip, playhead, sidecar, runtime.gpu);
  // The overlay only while the segmentation panel is open. A preview that was click-to-place at all
  // times would swallow every click meant for the picture, and the crosshair would be a promise
  // about a mode the user is not in.
  const segmenting = rightTab === 'segment';

  /**
   * How the preview resolves a mask an effect is bound to.
   *
   * From the live session, which is what closes the spec's §6.6: until now the renderer answered
   * every mask lookup with `undefined`, so a bound mask reached the compositor and drew nothing.
   * Bound to the *selected* clip's session, because that is the only one held in memory — a mask
   * survives on disk under `masks/`, and reading it back for an unselected clip is the next step.
   */
  const maskSource = useMemo(
    () => sessionMaskSource(masks.session, clipStartOf(document, selectedClip)),
    [document, masks.session, selectedClip],
  );

  // After the mask source, which it needs: an export that could not resolve a bound mask would render
  // it unmasked, and differ from the preview the user approved.
  const exportRun = useExportRun({
    document,
    sidecar,
    masks: maskSource,
    gpu: runtime.gpu,
    effects: effects.registry,
    resolveAsset: proxies.resolve,
  });

  /** What an effect on the selected clip may be bound to. */
  const maskChoices: readonly MaskChoice[] = useMemo(() => {
    const session = masks.session;
    if (session === undefined) return [];
    return [
      {
        id: maskIdForClip(session.track.clip),
        label: session.track.label ?? 'this clip',
        ready: session.frames.size > 0,
      },
    ];
  }, [masks.session]);
  // Which browser row has its name field open, and which folder is waiting for a name. Two states
  // rather than one: a new folder has no row to edit until it exists on disk.
  const [renamingPath, setRenamingPath] = useState<string | undefined>(undefined);
  const [newFolderIn, setNewFolderIn] = useState<string | undefined>(undefined);

  /**
   * Runs whatever the browser's menu chose, **on the row it was opened over**.
   *
   * The target is an argument rather than state read back when the action fires. It used to be the
   * latter, which is a stale read waiting to happen: between opening a menu and choosing from it the
   * selection can move, and "move to trash" acting on the wrong file is not a recoverable mistake.
   */
  /** Priced once per change rather than per right-click, since the menu is rebuilt on every render. */
  const cacheLabel = useMemo(() => describeCacheStats(derivedCache.stats), [derivedCache.stats]);

  const runBrowserMenuAction = useCallback(
    (target: BrowserMenuTarget, action: BrowserMenuAction) => {
      switch (action) {
        case 'new-folder':
          // Into the clicked folder, or beside a clicked file — which is where a user pointing at
          // something means, rather than always at the root.
          setNewFolderIn(target.isDirectory ? target.path : parentFolder(target.path));
          break;
        case 'rename':
          setRenamingPath(target.path);
          break;
        case 'reveal':
          void bridge()?.revealInFolder(target.path);
          break;
        case 'prune-takes':
          void proposePrune();
          break;
        case 'clear-cache':
          /*
           * No confirmation, unlike the prune beside it. What goes is derived from sources that are
           * still there and is rebuilt the moment it is wanted again, so the worst outcome is that
           * the next preview waits for a proxy — where an unused *take* is the only copy of something
           * a generator produced, and removing one is a decision.
           *
           * The tree is rescanned because `cache/` is a real folder in the browser, and rows for
           * files that are gone would sit there until the watcher's next debounce.
           */
          void derivedCache.clear().then(() => tree.refresh());
          break;
        case 'delete':
          void files.trash(target.path).then((done) => {
            // The watcher reports the removal, but a rescan makes the row go at once rather than at
            // the next debounce — a file that lingers after "Move to trash" reads as a failure.
            if (done) tree.refresh();
          });
          break;
        case 'import': {
          // Into the folder that was right-clicked when it is one, otherwise `media/`, which is where
          // §4 says imported source files live.
          const into = target.isDirectory && target.path !== undefined ? target.path : 'media';
          void (async () => {
            const chosen = await bridge()?.chooseFilesToImport();
            if (chosen !== undefined) await importInto(chosen, into);
          })();
          break;
        }
        default: {
          const unreachable: never = action;
          throw new Error(`Unhandled browser action ${String(unreachable)}`);
        }
      }
    },
    [files, importInto],
  );

  /**
   * The non-error status line.
   *
   * Two sources, one line: a mark that moved something the user did not touch, and a strip that could
   * not be derived. Neither is an error — the timeline still edits — but a silent one is found later,
   * as an export of the wrong length or a clip that stayed blank and read as a bug.
   */
  /*
   * Missing media comes first among the notices, because it is the only one of them that means the cut
   * is *wrong* rather than merely degraded. A proxy that has not built yet still shows the picture; a
   * file that has left the folder shows nothing, and nothing said so — a black frame with no
   * explanation reads as a bug in the editor rather than as a file the user moved.
   */
  /*
   * The folder's paths and the cut's needs are memoized apart, because they change at completely
   * different rates: the tree when the watcher says so, the document on every edit — and during a drag,
   * on every pointer move.
   */
  const onDisk = useMemo(() => filesOnDisk(tree.tree), [tree.tree]);
  const availability = useMemo(() => availabilityOf(document, onDisk), [document, onDisk]);
  /*
   * The set, built once per availability rather than per render.
   *
   * Built once per availability rather than per render: a fresh set in the timeline's props changes
   * identity every render, and during a drag that is every pointer move.
   */
  const missingAssets = useMemo(() => new Set(availability.missing), [availability]);

  /** The missing path behind the clip being relinked, and the files there are to choose from. */
  const relinkingAsset = useMemo(() => {
    if (relinking === undefined) return undefined;
    const located = locateClip(document, relinking);
    return located === undefined ? undefined : clipSource(located.clip)?.asset;
  }, [relinking, document]);
  const projectFiles = useMemo(
    () =>
      tree.tree === undefined
        ? []
        : allFiles(tree.tree)
            // Only files the application could actually type. Offering `project.json` as a
            // replacement for a missing clip is offering a mistake — the same rule the notes picker
            // follows.
            .filter((file) => file.assetType !== undefined)
            .map((file) => file.path),
    [tree.tree],
  );

  const notice =
    describeAvailability(availability) ??
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
          setError(describeEditError(result.error));
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
          setError(describeEditError(result.error));
          return current;
        }
        return result.value;
      });
    },
    [store],
  );

  /**
   * Reorders a track among its own kind.
   *
   * Layer order is what the compositor reads — video tracks are walked in reverse so a later one
   * draws on top — and until now it was fixed at creation with nothing able to change it.
   */
  const moveTrackBy = useCallback(
    (id: TrackId, delta: number) => {
      store.commit('move track', (current) => {
        const result = moveTrack(current, id, delta);
        if (!result.ok) {
          setError(describeEditError(result.error));
          return current;
        }
        setError(undefined);
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
          setError(describeEditError(result.error));
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
    (target: TimelineMenuTarget, action: ClipMenuAction) => {
      switch (action) {
        case 'add-video-track':
          addTrackOfKind('video');
          break;
        case 'add-audio-track':
          addTrackOfKind('audio');
          break;
        case 'add-text-track':
          addTrackOfKind('text');
          break;
        case 'rename-track':
          setRenamingTrack(target.track);
          break;
        case 'collapse-track':
          if (target.track !== undefined) toggleTrack(target.track, 'collapsed');
          break;
        case 'move-track-up':
        case 'move-track-down':
          if (target.track !== undefined) {
            moveTrackBy(target.track, action === 'move-track-up' ? -1 : 1);
          }
          break;
        case 'remove-track':
          if (target.track !== undefined) removeTrackById(target.track);
          break;
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
        case 'link':
          store.commit('link clips', (current) => {
            // Resolved again at the moment of acting rather than trusting what the menu decided when
            // it opened: the selection can change between the two, and linking the wrong pair is far
            // worse than a row that turns out to do nothing.
            const pair = linkablePair(current, [...selected] as ClipId[]);
            if (pair === undefined) return current;
            const result = linkClips(current, pair.video, pair.audio);
            if (!result.ok) {
              setError(describeEditError(result.error));
              return current;
            }
            return result.value;
          });
          break;
        case 'unlink':
          store.commit('unlink clips', (current) => {
            if (target.clip === undefined) return current;
            const result = unlinkClips(current, target.clip);
            if (!result.ok) {
              setError(describeEditError(result.error));
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
        case 'rename-clip':
          // Selecting first, because the menu can be opened over a clip that is not the selected one
          // and the inspector shows the selection. Renaming a clip the user is not looking at is the
          // one thing this must not do.
          if (target.clip !== undefined) setSelected(new Set([target.clip]));
          setRightTab('clip');
          setRenamingClip(target.clip);
          break;
        case 'crossfade-at-cut':
          if (target.clip !== undefined) {
            const current = store.getDocument();
            // The length the menu offered, recomputed from the same function the row used so the two
            // cannot disagree about what this cut can carry.
            const side = crossfadeSideFor(current, target.clip);
            const frames = Math.min(
              defaultCrossfadeFrames(current.frameRate),
              maxCrossfadeAtCut(current, target.clip, side),
            );
            const made = crossfadeAtCut({
              document: current,
              clip: target.clip,
              frames,
              ...(side === undefined ? {} : { side }),
            });
            if (made.ok) commitDocument('crossfade at the cut', made.value);
            else setError(describeEditError(made.error));
          }
          break;
        case 'close-gap':
          if (target.clip !== undefined) {
            const closed = closeGapBefore(store.getDocument(), target.clip);
            if (closed.ok) commitDocument('close the gap', closed.value);
            else setError(describeEditError(closed.error));
          }
          break;
        case 'close-track-gaps':
          if (target.track !== undefined) {
            const closed = closeAllGaps(store.getDocument(), target.track);
            if (closed.ok) commitDocument('close every gap', closed.value);
            else setError(describeEditError(closed.error));
          }
          break;
        case 'remove':
          clipEdits.remove();
          break;
        case 'relink':
          // Opens the chooser rather than repointing immediately: the candidates are a guess from the
          // file name, and a relink rewrites every clip reading that file. Confirmation belongs to the
          // user, not to a name match.
          setRelinking(target.clip);
          break;
        default: {
          const unreachable: never = action;
          throw new Error(`Unhandled menu action ${String(unreachable)}`);
        }
      }
    },
    [clipEdits, store, commitDocument],
  );

  /**
   * What the timeline's right-click offers, and what a choice does.
   *
   * One object because the two halves are useless apart, and because the panels render the menu
   * themselves now — this describes it, and `ActionMenu` turns the description into markup.
   */
  /*
   * The selected transition, which the timeline had no way to express.
   *
   * Kept apart from the clip selection rather than folded into it: a transition is not a clip, and
   * every operation that reads `selected` — split, delete, nudge, the effect stack — would have to
   * learn to ignore an id that is not one. Two small pieces of state that each mean one thing beat one
   * that means either.
   */
  const [selectedTransition, setSelectedTransition] = useState<EffectInstanceId>();
  const transitionDrag = useTransitionDrag({ document, viewport, commit: commitDocument });

  const timelineMenu: MenuBinding<TimelineMenuTarget> = useMemo(
    () =>
      menuBinding<TimelineMenuTarget, ClipMenuAction>(
        (target) =>
          clipMenuItems({
            document,
            clip: target.clip,
            track: target.track,
            selectionSize: selected.size,
            canPaste: clipEdits.canPaste,
            hasAttributes: clipEdits.attributeSummary !== undefined,
            offline: target.clip !== undefined && availability.isOffline(target.clip),
            canLink: linkablePair(document, [...selected] as ClipId[]) !== undefined,
            // Computed from the same function the action calls, so the row cannot promise a fade the
            // edit then refuses. Zero means the cut cannot carry one at all, and the row says so by
            // being offered without a length rather than vanishing.
            ...(target.clip !== undefined
              ? (() => {
                  const side = crossfadeSideFor(document, target.clip);
                  if (side === undefined) return {};
                  const room = maxCrossfadeAtCut(document, target.clip, side);
                  const frames = Math.min(defaultCrossfadeFrames(document.frameRate), room);
                  return frames >= 2 ? { crossfadeFrames: frames } : {};
                })()
              : {}),
            ...(target.track !== undefined
              ? {
                  canMoveTrackUp: canMoveTrack(document, target.track, -1),
                  canMoveTrackDown: canMoveTrack(document, target.track, 1),
                }
              : {}),
            ripple,
          }),
        runClipMenuAction,
      ),
    [clipEdits, document, ripple, runClipMenuAction, selected],
  );

  /**
   * Everything running, from every source that has any.
   *
   * Assembled here because this is the only place that can see all of them; each is adapted in
   * `activities.ts`, so adding a sixth source changes this list and nothing else.
   */
  /*
   * Runs a failed group's request again.
   *
   * Here rather than on the runtime because repeating a request needs the **manifest**, and the queue
   * keeps only a generator id — the registry that resolves one is the shell's. A generator removed
   * from the library since the run has no retry, and the button is simply not offered.
   *
   * The request is repeated as it was asked for: same parameters, same target, same variant count.
   * Seeds are derived afresh, and that is right — a failed run produced nothing, so there is no image
   * to reproduce, and the user is asking for the *request* again rather than for a particular result.
   */
  const retryGroup = useCallback(
    (id: JobGroupId) => {
      const request = retryRequest({ snapshot: runtime.snapshot, registry: library.registry }, id);
      if (request !== undefined) runtime.run(request);
    },
    [library.registry, runtime],
  );

  /**
   * Opens the file manager on a project-relative asset.
   *
   * The bridge takes a path and the queue records one, so this is a conversion and a call. It exists
   * as its own callback rather than inline so the identity is stable across renders — the activity
   * list is rebuilt from it on every queue tick.
   */
  const revealAsset = useCallback((path: string) => {
    void bridge()?.revealInFolder(path);
  }, []);

  const activities = useMemo(
    () =>
      orderActivities([
        ...generatorActivities(runtime.snapshot, { onRetry: retryGroup, onReveal: revealAsset }),
        ...exportActivity(exportRun.progress),
        ...derivationActivity(proxies.pending.length, proxies.ready),
        ...segmentationActivity(masks.session?.running === true, masks.session?.progress, masks.error),
      ]),
    [exportRun.progress, masks.error, masks.session, proxies.pending.length, proxies.ready, runtime.snapshot],
  );

  /**
   * What the application needs to say, and the decisions some of it carries.
   *
   * Errors first: a failure is the thing a user must not miss, and the recovery offer below it is a
   * question they can take their time over.
   */
  const notices = useMemo((): readonly StatusNotice[] => {
    const failure = error ?? drag.rejection ?? exportRun.error ?? mediaImport.error;
    return [
      ...(failure !== undefined
        ? [
            {
              id: 'error',
              tone: 'error' as const,
              message: failure,
              // Only when the shell owns the message. A close button on an export's error would have
              // to leave the error where it was, and a control that visibly does nothing is worse
              // than none.
              onDismiss: failure === error ? () => setError(undefined) : undefined,
            },
          ]
        : []),
      ...(confirmation.message !== undefined
        ? [
            {
              id: 'confirmation',
              tone: 'info' as const,
              message: confirmation.message,
              onDismiss: confirmation.clear,
            },
          ]
        : []),
      /*
       * Missing media carries its own repair.
       *
       * The notice is where a user first learns a file has gone, and until now the fix lived only in a
       * clip's context menu — so the message told them about a problem and left them to find the
       * answer somewhere else. A notice that names a problem it can solve should offer to.
       */
      ...(notice !== undefined
        ? [
            {
              id: 'notice',
              tone: 'warning' as const,
              message: notice,
              ...(availability.missing.length > 0
                ? {
                    actions: [
                      {
                        label: 'Relink…',
                        primary: true,
                        // The first clip using the first missing file, because the dialog is *about* an
                        // asset and needs a clip only to find which one.
                        onClick: () => setRelinking(availability.offlineClips[0]),
                      },
                    ],
                  }
                : {}),
            },
          ]
        : []),
      ...(blocked !== undefined
        ? [
            {
              id: 'variant-collision',
              tone: 'warning' as const,
              message: `${blocked.manifest.name} would land on top of a clip already on ${blocked.track}`,
              actions: [
                {
                  // Honest about both outcomes: it prefers a free track of the same kind and adds one
                  // only when there is none. Either way nothing already on the timeline moves.
                  label: 'Find room for it',
                  onClick: () => landVariant(blocked.outcome, blocked.manifest, 'find-room'),
                  primary: true,
                },
                { label: 'Leave it', onClick: () => setBlocked(undefined) },
              ],
            },
          ]
        : []),
      ...(autosave.offer !== undefined
        ? [
            {
              id: 'recovery',
              tone: 'info' as const,
              message: `unsaved work from ${
                autosave.offeredAt === undefined
                  ? 'a previous session'
                  : new Date(autosave.offeredAt).toLocaleString()
              } was recovered`,
              actions: [
                { label: 'Restore it', onClick: autosave.accept, primary: true },
                { label: 'Discard', onClick: autosave.discard },
              ],
            },
          ]
        : []),
    ];
  }, [
    autosave,
    blocked,
    confirmation,
    drag.rejection,
    error,
    exportRun.error,
    landVariant,
    mediaImport.error,
    notice,
  ]);

  const browserMenu: MenuBinding<BrowserMenuTarget> = useMemo(
    () =>
      menuBinding<BrowserMenuTarget, BrowserMenuAction>(
        (target) =>
          browserMenuItems({
            path: target.path === '' ? undefined : target.path,
            isDirectory: target.isDirectory,
            ...(cacheLabel === undefined ? {} : { cache: cacheLabel }),
          }),
        runBrowserMenuAction,
      ),
    [cacheLabel, runBrowserMenuAction],
  );

  return (
    <div className="flex h-screen flex-col">
      {/*
        The tab bar is the topmost thing in the window, and everything below it belongs to the tab —
        including the title bar, whose actions are the *editor's* actions. It used to sit under the
        title bar, which made a tab govern a strip in the middle rather than the window.

        The status bar stays outside, deliberately: issue #22 asked for a persistent bottom row that
        shows what is running in the background, and a generation that vanishes because you opened a
        shader is exactly what that bar exists to prevent.
      */}
      <WorkspaceTabs
        tabs={workspace.tabs.map((tab) => ({
          id: tab.id,
          title: tab.title,
          icon: <TabGlyph kind={tab.kind} />,
          closable: descriptorFor(tab.kind).closable,
        }))}
        active={workspace.active}
        onSelect={(id) => setWorkspace((current) => focusTab(current, id))}
        onClose={(id) => setWorkspace((current) => closeTab(current, id))}
      />

      <ShortcutSheet groups={SHORTCUT_GROUPS} open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      <UnreadableProject
        project={unreadable}
        onDismiss={() => setUnreadable(undefined)}
        onReveal={() => {
          if (unreadable !== undefined) void bridge()?.revealInFolder(`${unreadable.root}/project.json`);
        }}
      />

      <Dialog open={prune !== undefined} onOpenChange={(open) => !open && setPrune(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove unused takes</DialogTitle>
            <DialogDescription>
              {/* The count, the size and what is being kept. A bulk removal that does not say how much
                  it is about to take is one a user has to test on a project they do not care about. */}
              {prune === undefined
                ? ''
                : `${prune.unused.length} generated take${prune.unused.length === 1 ? '' : 's'} ` +
                  `${prune.unused.length === 1 ? 'is' : 'are'} not used anywhere in this sequence, ` +
                  `and ${formatBytes(prune.bytes)} would be reclaimed. ` +
                  `${prune.usedCount} in use ${prune.usedCount === 1 ? 'is' : 'are'} kept.`}
            </DialogDescription>
          </DialogHeader>

          {/* Named, not just counted. A list is the difference between a user agreeing to this once and
              a user agreeing to it every time. */}
          <ScrollArea className="max-h-52 rounded-md border">
            <ul className="flex flex-col p-2 font-mono text-xs">
              {prune?.unused.map((take) => (
                <li key={take.path} className="truncate py-0.5 text-muted-foreground">
                  {take.path}
                </li>
              ))}
            </ul>
          </ScrollArea>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPrune(undefined)}>
              Cancel
            </Button>
            <Button onClick={() => void runPrune()}>
              <Trash2Icon />
              Move to trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {newFolderIn !== undefined && (
        <NewFolderPrompt
          parent={newFolderIn}
          onCancel={() => setNewFolderIn(undefined)}
          onConfirm={(name) => {
            setNewFolderIn(undefined);
            void files.createFolder(newFolderIn, name).then((done) => {
              if (done) tree.refresh();
            });
          }}
        />
      )}

      {authoring && (
        <ManifestAuthoring
          graphs={library.graphs}
          // Every id the library holds, so saving cannot silently replace a generator the user did not
          // open — the id is the filename, and two manifests cannot share one.
          takenIds={new Set(library.manifests.map((manifest) => manifest.id as string))}
          onClose={() => setAuthoring(false)}
          onSaved={library.reload}
        />
      )}

      {showing.kind === 'text' && showing.subject !== undefined && (
        <TextEditorTab
          path={showing.subject}
          // Saving a manifest takes effect without a restart: both libraries re-read the folder.
          onSaved={() => {
            effects.reload();
            library.reload();
          }}
        />
      )}

      {showing.kind === 'story' && (
        <StoryTab
          document={document}
          playhead={playhead}
          onChangeDocument={commitDocument}
          onSeek={transport.seek}
          // What the media browser has selected: attaching a reference is one gesture after looking at
          // the file, rather than a second file tree that would have to be kept in step with the first.
          {...(browserSelection !== undefined ? { attachable: browserSelection as AssetPath } : {})}
          // The sidecar serves the project folder, which is how a reference is *shown* rather than
          // named. Absent while it is starting, which the board reports as a glyph and not a failure.
          {...(sidecar !== undefined ? { sidecar } : {})}
          onOpenAsset={(asset) => setBrowserSelection(asset)}
        />
      )}

      {showing.kind === 'effect' && (
        <EffectAuthoring
          // The project's own effects, so saving cannot silently replace one — the id is two filenames
          // and two effects cannot share it.
          existing={projectEffects}
          {...(showing.subject !== undefined ? { editing: showing.subject } : {})}
          // The tab's title follows the effect as it is named, so a bar of unsaved effects is usable.
          onTitle={(title) => setWorkspace((current) => retitleTab(current, showing.id, title))}
          onClose={() => setWorkspace((current) => closeTab(current, showing.id))}
          onSaved={effects.reload}
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
          // The folder as the watcher last reported it. The encoder overwrites, and the dialog offers
          // the same destination every time it opens, so without this a second export silently
          // replaced the first.
          {...(onDisk !== undefined ? { existingFiles: onDisk } : {})}
        />
      )}

      <RelinkDialog
        {...(relinkingAsset !== undefined ? { missing: relinkingAsset } : { missing: undefined })}
        present={projectFiles}
        affected={relinkingAsset === undefined ? 0 : clipsUsing(document, relinkingAsset).length}
        onRelink={(to) => {
          if (relinkingAsset === undefined) return;
          // One undo step for the whole rewrite: the file moved once, so putting it back should cost
          // one press rather than one per clip that followed it.
          store.commit('relink media', (current) => relinkAsset(current, relinkingAsset, to));
          setRelinking(undefined);
        }}
        onClose={() => setRelinking(undefined)}
      />

      {/*
        Three columns and, inside the middle one, two rows — every boundary draggable, and the two side
        panels collapsible to nothing. They were fixed at 280, 340 and 392 pixels, which is a reasonable
        default and a poor rule: a timeline is what you want tall while cutting and short while framing,
        and a browser is what you want gone entirely on a laptop.

        The handles carry a grip, because a boundary that only reveals itself on hover is one nobody
        finds. Where they are left is remembered — a panel a user drags every session is one that
        should have stayed where they put it.
      */}
      {/*
        Hidden rather than unmounted when another tab is showing.
        Unmounting would drop the preview's GL context and every scroll position in the window, and
        rebuilding them on each tab switch is both slow and visible. `hidden` costs nothing.
      */}
      <div className={cn('flex min-h-0 flex-1 flex-col', showing.kind !== 'editor' && 'hidden')}>
        <TitleBar
          project={project}
          sidecar={sidecar}
          dirty={store.getSnapshot().dirty}
          onOpen={() => void openProject()}
          onOpenPath={(root) => void openProjectAt(root)}
          openedCount={openedCount}
          onSave={() => void save()}
          onExport={openExport}
          autosaveStatus={autosave.status}
          onShowShortcuts={() => setShortcutsOpen(true)}
          themeId={appSettings.settings?.theme}
          onChangeTheme={(theme) => appSettings.update({ theme })}
          onOpenStory={() => setWorkspace((current) => openTab(current, { kind: 'story' }))}
          history={history}
        />

        <ResizablePanelGroup
          orientation="horizontal"
          {...(columns.layout !== undefined ? { defaultLayout: columns.layout } : {})}
          onLayoutChange={columns.onLayoutChange}
          className="min-h-0 flex-1"
        >
          <ResizablePanel
            id="browser"
            defaultSize="18%"
            minSize="12%"
            collapsible
            collapsedSize={0}
            className="min-w-0 border-r"
          >
            <MediaBrowser
              tree={tree.tree ?? buildTree([])}
              durations={mediaDurations}
              projectOpen={project !== undefined}
              onImportFiles={(dropped) => {
                /*
                 * A renderer cannot name a file on disk, so the paths come back through the preload —
                 * and anything that is not a real file answers with an empty string, which a drag
                 * carrying text does.
                 */
                const api = bridge();
                if (api === undefined) return;
                const paths = dropped.map((file) => api.pathForFile(file)).filter((path) => path !== '');
                void importInto(paths, 'media');
              }}
              watcher={tree.watcher}
              onRescan={tree.refresh}
              {...(browserSelection !== undefined ? { selected: browserSelection } : {})}
              onSelect={setBrowserSelection}
              detail={
                <BrowserDetail
                  asset={assetDetail}
                  cache={cache}
                  // Through the shell, so a link in a note opens in the system browser rather than
                  // navigating this window away from the editor.
                  onOpenLink={(href) => void bridge()?.openExternal(href)}
                  onRecall={recallGeneration}
                />
              }
              menu={browserMenu}
              {...(renamingPath !== undefined ? { renamingPath } : {})}
              onRename={(path, name) => {
                setRenamingPath(undefined);
                void files.rename(path, name).then((done) => {
                  if (done) tree.refresh();
                });
              }}
              onMove={(source, destination) => {
                void files.move(source, destination).then((done) => {
                  if (done) tree.refresh();
                });
              }}
              onActivate={(asset) => {
                /*
                 * A project folder is not only a bag of media. Issue #32: double-clicking a `.frag`
                 * said "…is not something that can go on the timeline", which is true and left the
                 * user nowhere — a shader has an editor, and a manifest and a note now do too.
                 */
                const action = actionFor(asset);

                if (action.kind === 'none') {
                  setError(action.reason);
                  return;
                }

                if (action.kind === 'tab') {
                  // A shader is half of an effect: the editor opens on the *effect*, found by the
                  // manifest that names the file. One nothing claims is an orphan — real while a
                  // shader is being written — and opens as text so it can still be edited.
                  const effect =
                    action.tab === 'effect'
                      ? effectForShader(
                          asset,
                          projectEffects.map((entry) => ({
                            id: entry.manifest.id as string,
                            shader: entry.manifest.shader,
                          })),
                        )
                      : undefined;

                  setWorkspace((current) =>
                    action.tab === 'effect' && effect === undefined
                      ? openTab(current, { kind: 'text', subject: asset, title: baseNameOf(asset) })
                      : openTab(current, {
                          kind: action.tab,
                          subject: effect ?? asset,
                          title: effect ?? baseNameOf(asset),
                        }),
                  );
                  return;
                }

                void mediaImport.run(asset, playhead).then((id) => {
                  // Selected on arrival, because the next thing a user does with a clip they just added is
                  // almost always to it.
                  if (id !== undefined) setSelected(new Set([id]));
                });
              }}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />

          <ResizablePanel id="stage" minSize="30%" className="min-w-0">
            <ResizablePanelGroup
              orientation="vertical"
              {...(rows.layout !== undefined ? { defaultLayout: rows.layout } : {})}
              onLayoutChange={rows.onLayoutChange}
              className="min-h-0"
            >
              <ResizablePanel id="viewer" defaultSize="62%" minSize="20%" className="min-h-0">
                <main className="flex h-full min-w-0 flex-col">
                  <Preview
                    document={drag.document}
                    frame={playhead}
                    sidecar={sidecar}
                    resolveAsset={proxies.resolve}
                    masks={maskSource}
                    effects={effects.registry}
                    {...(segmenting && masks.session !== undefined
                      ? {
                          overlay: (picture: { readonly width: number; readonly height: number }) => (
                            <MaskPointOverlay
                              session={masks.session!}
                              width={picture.width}
                              height={picture.height}
                              onAddPrompt={masks.addPrompt}
                              onRemovePrompt={masks.removePrompt}
                            />
                          ),
                        }
                      : {})}
                  />

                  {/* Under the picture it controls. In the title bar it sat among file and project actions,
              a hand's width from the frame a user is scrubbing and beside buttons that have nothing
              to do with playback. */}
                  <Transport
                    transport={transport}
                    frameRate={document.frameRate}
                    duration={documentDuration(document)}
                    meters={audio.meters}
                    onClearClip={audio.clearClip}
                  />
                </main>
              </ResizablePanel>
              <ResizableHandle withHandle />

              <ResizablePanel id="timeline" defaultSize="38%" minSize="12%" className="min-h-0">
                <div ref={laneRef} className="h-full">
                  <Timeline
                    document={drag.document}
                    strips={strips.strips}
                    missingAssets={missingAssets}
                    onAddTrack={addTrackOfKind}
                    onTrackRemove={removeTrackById}
                    onTrackRename={(id, name) => {
                      setRenamingTrack(undefined);
                      store.commit('rename track', (current) => {
                        const result = renameTrack(current, id, name);
                        if (!result.ok) {
                          setError(describeEditError(result.error));
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
                    onTrackCollapse={(id) => toggleTrack(id, 'collapsed')}
                    onEditMarker={editMarker}
                    onRemoveMarker={removeMarkerAt}
                    onMarkIn={range.markIn}
                    onMarkOut={range.markOut}
                    onClearRange={range.clear}
                    {...(clipEdits.hasRange ? { onRemoveRange: clipEdits.removeRange } : {})}
                    viewport={viewport}
                    playhead={playhead}
                    selectedClips={selected}
                    snapEnabled={snap}
                    rippleEnabled={ripple}
                    onScrub={scrubTo}
                    scrubAudioEnabled={scrubAudio}
                    onToggleScrubAudio={() => setScrubAudio((on) => !on)}
                    onSelectClip={(clip, additive) =>
                      setSelected((current) =>
                        additive ? new Set([...current, clip]) : new Set([clip as string]),
                      )
                    }
                    // A marquee reports frames and tracks; which clips that touches is the document's
                    // question, answered in the editing layer rather than in the component.
                    // Dropped material lands where it was dropped — which is the only reason to drag
                    // rather than double-click, and what the browser's draggable rows had been promising.
                    {...(renamingTrack !== undefined ? { renamingTrack } : {})}
                    onDropAsset={(asset, track, frame) => {
                      void mediaImport.run(asset as AssetPath, frame, track).then((id) => {
                        if (id !== undefined) setSelected(new Set([id]));
                      });
                    }}
                    menu={timelineMenu}
                    onSelectRegion={(region, additive) =>
                      setSelected((current) =>
                        combineSelection(current, clipsInRegion(document, region), additive),
                      )
                    }
                    // Alt turns a move into a slip. The clip stays put and its content slides inside it —
                    // the spec's csúsztatás, and the one edit whose result the clip's outline cannot show.
                    onClipPointerDown={(clip, event) =>
                      drag.begin(event.altKey ? 'slip' : 'move', clip, event)
                    }
                    // Shift rolls the cut instead of trimming one side of it: the outgoing clip gains
                    // exactly what the incoming one gives up, so nothing downstream moves. It is the edit
                    // an editor reaches for constantly — the cut is a frame late, so you move the cut.
                    onTrimStart={(clip, event) =>
                      drag.begin(event.shiftKey ? 'roll' : 'trim-start', clip, event)
                    }
                    onTrimEnd={(clip, event) => drag.begin(event.shiftKey ? 'roll' : 'trim-end', clip, event)}
                    // A fade is its own gesture on its own handle. Overlapping two clips writes the
                    // ramps automatically, and this is how one is made — or unmade — without moving
                    // anything.
                    onFadeDrag={(clip, edge, event) =>
                      drag.begin(edge === 'in' ? 'fade-in' : 'fade-out', clip, event)
                    }
                    {...(selectedTransition !== undefined ? { selectedTransition } : {})}
                    onSelectTransition={(id) => {
                      setSelectedTransition(id);
                      // Selecting a transition clears the clip selection, so the inspector is about
                      // one thing and Delete has one meaning.
                      setSelected(new Set());
                    }}
                    onResizeTransition={(id, event) => {
                      const transition = findTransition(document, id);
                      if (transition !== undefined) transitionDrag.begin(transition, event);
                    }}
                    onRemoveTransition={(id) => {
                      const result = removeTransition(document, id);
                      if (result.ok) {
                        commitDocument('remove transition', result.value);
                        setSelectedTransition(undefined);
                      } else confirmation.say(describeTransitionError(result.error));
                    }}
                    // The registry's own name for the effect, so the band says "Cross dissolve"
                    // rather than `cross_dissolve`.
                    transitionLabel={(effect) =>
                      effectRegistry.manifestFor(effect)?.name ?? (effect as string)
                    }
                    {...(expandedClip !== undefined ? { expandedClip } : {})}
                    onToggleExpandClip={(clip) =>
                      setExpandedClip((current) => (current === clip ? undefined : clip))
                    }
                    lanes={keyframes.rows}
                    {...(drag.snappedTo !== undefined
                      ? { snapIndicator: { frame: drag.snappedTo.frame, kind: drag.snappedTo.kind } }
                      : {})}
                    onToggleSnap={() => setSnap((value) => !value)}
                    onToggleRipple={() => setRipple((value) => !value)}
                    loopEnabled={looping}
                    onToggleLoop={() => setLooping((value) => !value)}
                    onZoom={view.zoomAt}
                    onScrollBy={view.scrollBy}
                    onFit={view.fit}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />

          <ResizablePanel
            id="inspector"
            defaultSize="22%"
            minSize="14%"
            collapsible
            collapsedSize={0}
            className="min-w-0 border-l"
          >
            <RightPanel
              onSeek={transport.seek}
              onEditMarker={editMarker}
              onRemoveMarker={removeMarkerAt}
              projectTree={tree.tree}
              masks={masks}
              maskChoices={maskChoices}
              tab={rightTab}
              onTabChange={setRightTab}
              takesWaiting={takesWaiting}
              onCreateEffect={() => setWorkspace((current) => openTab(current, { kind: 'effect' }))}
              onEditEffect={(id) =>
                setWorkspace((current) => openTab(current, { kind: 'effect', subject: id }))
              }
              // Only the project's own effects: a builtin ships in the binary and has no file to open.
              editableEffects={new Set(projectEffects.map((entry) => entry.manifest.id as string))}
              recalled={recalled}
              effectProblems={effects.problems}
              onRenameClip={renameClip}
              renamingClip={renamingClip !== undefined && renamingClip === [...selected][0]}
              {...(keyframes.selected !== undefined ? { keyframe: keyframes.selected } : {})}
              onEditKeyframe={keyframes.edit}
              onRemoveKeyframe={keyframes.remove}
              document={document}
              effects={effectRegistry}
              onChangeDocument={commitDocument}
              registry={library.registry}
              {...(appSettings.settings !== undefined ? { appSettings: appSettings.settings } : {})}
              onChangeAppSettings={appSettings.update}
              libraryProblems={library.problems}
              libraryPath={library.libraryPath}
              runtime={runtime}
              playhead={playhead}
              sidecar={sidecar}
              selectedClip={[...selected][0]}
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
              onAddText={addText}
              onReject={setError}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <StatusBar activities={activities} notices={notices}>
        {/* Before the export timing, because it explains why something is not moving — which is read
            first when something is not moving. */}
        {/*
          A clip that outruns its own media, which nothing said before: the frame shows whatever the
          decoder has left, and black at the end of a shot looks exactly like a shot meant to end on
          black. Named rather than repaired — shortening the clip would be an edit nobody asked for.
        */}
        {overrunNote !== undefined && (
          <span className="flex items-center gap-1.5 font-mono text-amber-500">
            <TriangleAlertIcon className="size-3.5" />
            {overrunNote}
          </span>
        )}
        {gpuNote !== undefined && <span className="font-mono text-muted-foreground">{gpuNote}</span>}
        {exportRun.timing !== undefined && (
          <span className="font-mono text-muted-foreground">{describeTiming(exportRun.timing)}</span>
        )}
      </StatusBar>
    </div>
  );
}

/**
 * Asking for a folder's name before making it.
 *
 * A prompt rather than creating `New folder` and opening its name field: the empty-name case is not
 * reachable this way, and a cancelled prompt leaves nothing behind — whereas a cancelled inline
 * rename would leave a folder called `New folder` in a project the user was tidying.
 */
function NewFolderPrompt({
  parent,
  onCancel,
  onConfirm,
}: {
  readonly parent: string;
  readonly onCancel: () => void;
  readonly onConfirm: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent aria-label="New folder" className="sm:max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== '') onConfirm(name);
          }}
          // Submitting on Enter is what a one-field prompt should do, and the form gives it for free.
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderPlusIcon className="size-4" />
              New folder
            </DialogTitle>
            <DialogDescription>{parent === '' ? 'in the project root' : `in ${parent}`}</DialogDescription>
          </DialogHeader>
          <Input
            id="new-folder-name"
            aria-label="Folder name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim() === ''}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TitleBar({
  project,
  sidecar,
  dirty,
  onOpen,
  onOpenPath,
  openedCount,
  onSave,
  onExport,
  autosaveStatus,
  onShowShortcuts,
  themeId,
  onChangeTheme,
  onOpenStory,
  history,
}: {
  readonly project: ProjectInfo | undefined;
  readonly sidecar: SidecarInfo | undefined;
  readonly dirty: boolean;
  readonly onOpen: () => void;
  readonly onOpenPath: (root: string) => void;
  /** Changes when a project opens, so the reopen list re-reads. */
  readonly openedCount: number;
  readonly onSave: () => void;
  readonly onExport: () => void;
  readonly autosaveStatus: AutosaveStatus;
  readonly onShowShortcuts: () => void;
  readonly themeId: string | undefined;
  readonly onChangeTheme: (theme: string) => void;
  readonly onOpenStory: () => void;
  readonly history: HistoryControls;
}): ReactNode {
  return (
    <header className="flex h-11 flex-none items-center gap-3 border-b px-4">
      <FilmIcon className="size-4 text-primary" />
      <span className="text-[10px] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
        Necro Omni Studio
      </span>
      <span className="text-sm">
        {project?.name ?? 'no project open'}
        {dirty ? ' •' : ''}
      </span>

      {/* The sidecar's state is shown rather than hidden: without it there are no proxies, no
          waveforms and no export, and a user who cannot see that will blame the application.

          The job count that used to sit beside it has moved to the status bar, where it opens into
          the list of what is actually running — a bare `3 jobs` was the whole of what the application
          said about generation, and there was no way to learn which three. */}
      <Badge
        variant={sidecar?.available === true ? 'secondary' : 'outline'}
        className="ml-auto font-mono"
        title={sidecar?.detail ?? ''}
      >
        {/* Colour on the glyph, never on the words — no chart role clears AA as text in any of the
            shipped themes. See the theme rules in the plan. */}
        <ServerIcon className={cn(sidecar?.available === true && 'text-chart-2')} />
        {sidecar === undefined ? 'sidecar idle' : sidecar.available ? 'sidecar ready' : 'sidecar unavailable'}
      </Badge>
      {project !== undefined && <AutosaveChip status={autosaveStatus} />}
      {/* A button as well as the `?` chord, because a reference reachable only by a shortcut is one
          only the people who do not need it can open. */}
      <HistoryButtons history={history} />
      <Button variant="ghost" size="icon-sm" onClick={onShowShortcuts} title="Keyboard and pointer (?)">
        <KeyboardIcon />
        <span className="sr-only">Keyboard and pointer</span>
      </Button>
      <ThemePicker themeId={themeId} onChange={onChangeTheme} />
      <ModeToggle />
      <Separator orientation="vertical" className="h-4" />
      {/* A button, not only a menu item. Issue #32 was somebody unable to find the effect editor at
          all, and a board nothing points at is a board nobody opens. */}
      <Button variant="ghost" size="sm" onClick={onOpenStory} disabled={project === undefined}>
        <ClapperboardIcon />
        Story
      </Button>
      <RecentProjects onOpen={onOpen} onOpenPath={onOpenPath} revision={openedCount} />
      <Button variant="ghost" size="sm" onClick={onSave} disabled={project === undefined}>
        <SaveIcon />
        Save
      </Button>
      <Button size="sm" onClick={onExport} disabled={project === undefined}>
        <UploadIcon />
        Export
      </Button>
    </header>
  );
}

/** What the title bar needs to offer undo and redo, and to say what each would take back. */
export interface HistoryControls {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The label the store recorded for the edit undo would reverse. */
  readonly undoLabel: string | undefined;
  readonly redoLabel: string | undefined;
  /** Every step, oldest first, with `offset: 0` marking now. */
  readonly steps: readonly HistoryStep[];
  undo(): void;
  redo(): void;
  /** Moves the given number of steps, negative for back. */
  jump(offset: number): void;
}

/**
 * Undo and redo, in the title bar, naming the edit.
 *
 * §6.1 asks for undo and redo on *everything*, and until now the only visible pair sat inside the
 * clip actions — on one tab, and only while a clip was selected. So the control for taking back a
 * mistake disappeared exactly when the mistake was made somewhere other than a clip: a track deleted,
 * a project setting changed, a manifest saved. The keyboard worked throughout, which is what kept
 * this invisible: everyone who tested it knew the chord.
 *
 * The title bar, because these are the *editor's* actions and the workspace-tab rule puts those here
 * — and because a control that moves depending on which tab is open is one you look for rather than
 * reach for.
 *
 * **It says what it will undo.** Every commit in this application already carries a label — the store
 * has recorded one since M1 and `StoreSnapshot` has exposed it just as long, and nothing has ever
 * read it. "Undo" is a promise with no content; "Undo close the gap" is one you can act on, and it is
 * the difference between pressing it and wondering what you just lost.
 */
export function HistoryButtons({ history }: { readonly history: HistoryControls }): ReactNode {
  return (
    <span className="flex items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={history.undo}
        disabled={!history.canUndo}
        // Named in the tooltip rather than in the button, because the label is as long as the edit
        // that made it and a title bar that reflowed on every edit would be its own distraction.
        title={history.undoLabel === undefined ? 'Nothing to undo' : `Undo ${history.undoLabel} (Ctrl+Z)`}
        aria-label={history.undoLabel === undefined ? 'Nothing to undo' : `Undo ${history.undoLabel}`}
      >
        <UndoIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={history.redo}
        disabled={!history.canRedo}
        title={
          history.redoLabel === undefined ? 'Nothing to redo' : `Redo ${history.redoLabel} (Ctrl+Shift+Z)`
        }
        aria-label={history.redoLabel === undefined ? 'Nothing to redo' : `Redo ${history.redoLabel}`}
      >
        <RedoIcon />
      </Button>
      <HistoryList history={history} />
    </span>
  );
}

/**
 * What has been done, and a way back to any of it.
 *
 * The store has carried a label on every commit since M1 and the whole stack has been in the snapshot
 * just as long; two buttons could only ever read the top of it. The question this answers is the one a
 * user has after ten minutes of cutting — *what did I do, and how far back is the point I want* — and
 * the previous answer was to press `Ctrl+Z` ten times and watch for the moment it looked right. Ten
 * presses is ten chances to overshoot, and overshooting is how a redo stack gets thrown away.
 *
 * Newest first, because the step someone wants is almost always a recent one and a list that grows
 * downwards puts it further from the pointer with every edit. Capped, for the same reason: past a
 * couple of dozen entries this is not a list anyone reads.
 *
 * Undone steps stay on it, dimmed and still reachable. Dropping them would make redo look like a dead
 * button — and the moment after an undo is exactly when someone wants to see what they just left.
 */
function HistoryList({ history }: { readonly history: HistoryControls }): ReactNode {
  // Nothing to choose from on a fresh document: one entry is the present, and a menu whose only row is
  // "you are here" is a control that does nothing.
  if (history.steps.length < 2) return null;

  const recent = [...history.steps].reverse().slice(0, HISTORY_LIST_LIMIT);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="History" title="What has been done">
            <HistoryIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-56">
        {recent.map((step) => (
          <DropdownMenuItem
            // Offset, not index: a list built one render ago names a step a commit in between may have
            // dropped, and an index into a stack that has changed points at the wrong edit.
            key={`${step.offset}:${step.label}`}
            onClick={() => history.jump(step.offset)}
            className={step.offset > 0 ? 'text-muted-foreground' : undefined}
          >
            <span className="truncate">{step.label}</span>
            {step.offset === 0 && <span className="ml-auto shrink-0 text-xs text-muted-foreground">now</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Past this, a history list is something to scroll rather than something to read. */
const HISTORY_LIST_LIMIT = 24;

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
  duration,
  meters,
  onClearClip,
}: {
  readonly transport: Transport;
  readonly frameRate: FrameRate;
  /** Sequence length, so an entry past the end lands on the last frame rather than being refused. */
  readonly duration: number;
  readonly meters: MeterReading | undefined;
  readonly onClearClip: () => void;
}): ReactNode {
  return (
    <div aria-label="Transport" className="flex h-13 flex-none items-center gap-2 border-y px-4">
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => transport.step(-1)}
        aria-label="Previous frame"
        title="Previous frame (←)"
      >
        <SkipBackIcon />
      </Button>
      <Button
        variant={transport.playing ? 'secondary' : 'default'}
        size="icon-sm"
        onClick={transport.toggle}
        aria-label={transport.playing ? 'Pause' : 'Play'}
        aria-pressed={transport.playing}
        title="Play or pause (space)"
      >
        {transport.playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => transport.step(1)}
        aria-label="Next frame"
        title="Next frame (→)"
      >
        <SkipForwardIcon />
      </Button>

      {/* Typed into as well as read. The position was shown and there was no way to go to one, and
          "go to 00:01:14:03" is what a note from someone else always says. */}
      <TimecodeField
        frame={transport.frame}
        frameRate={frameRate}
        {...(duration > 0 ? { duration } : {})}
        onSeek={transport.seek}
      />

      {/* Beside the timecode, where an editor already looks during playback. A mix with no meter is a
          mix that can only be checked by exporting it and listening. */}
      <LevelMeter
        className="ml-auto"
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
      className={cn(
        'font-mono text-xs',
        status.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
      )}
      title="Autosave writes a recovery file beside the project; it never overwrites project.json"
    >
      {describeAutosave(status, now)}
    </span>
  );
}

export { trimClipEnd, trimClipStart };

/** The last path segment, which is what a tab should be called rather than the whole path. */
function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The icon for a tab's kind.
 *
 * Here rather than in the bar, which is deliberately ignorant of what a kind means — that is what
 * makes a new kind an entry in `WORKSPACE_TAB_KINDS` plus a line here, rather than an edit to the tab
 * bar itself.
 */
function TabGlyph({ kind }: { readonly kind: WorkspaceTabKind }): ReactNode {
  switch (kind) {
    case 'effect':
      return <FileCode2Icon className="size-3.5" />;
    case 'text':
      return <FileJsonIcon className="size-3.5" />;
    case 'story':
      return <ClapperboardIcon className="size-3.5" />;
    default:
      return <FilmIcon className="size-3.5" />;
  }
}

/**
 * A project that could not be opened, and what to do about it.
 *
 * A dialog rather than a line in the status bar, because this is the one message in the application
 * that must not be missed: the alternative reading — "nothing happened when I opened my project" — is
 * exactly what a user concludes from a notice that scrolls past.
 *
 * Three things it has to do, and the old one did none of them. Say *which* file. Say *why*, in the
 * words the describer already produces, which names the offending path. And leave the file alone —
 * the editor has not touched it, so a text editor can still repair it, which is the only actual way
 * forward and is therefore what the button offers.
 */
function UnreadableProject({
  project,
  onDismiss,
  onReveal,
}: {
  readonly project: { readonly root: string; readonly name: string; readonly reason: string } | undefined;
  readonly onDismiss: () => void;
  readonly onReveal: () => void;
}): ReactNode {
  return (
    <Dialog open={project !== undefined} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{`${project?.name ?? 'That project'} could not be opened`}</DialogTitle>
          <DialogDescription>
            Nothing has been changed on disk. The file is still there and still repairable.
          </DialogDescription>
        </DialogHeader>

        {/* The reason verbatim, wrapped rather than truncated: a schema failure names the path that
            is wrong, and a path the user cannot read is a reason they cannot act on. */}
        <pre className="bg-muted max-h-48 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
          {project?.reason ?? ''}
        </pre>

        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss}>
            Close
          </Button>
          <Button variant="outline" onClick={onReveal}>
            <ExternalLinkIcon />
            Show project.json
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
