import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AssetPath,
  type AutosaveStatus,
  type Clip,
  type ClipId,
  type FrameIndex,
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
  loadDocument,
  locateClip,
  projectId,
  saveDocument,
  sequenceId,
  trackId,
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
  moveClip,
  moveTrack,
  nextTrackId,
  removeMarker,
  removeTrack,
  renameTrack,
  setClipLabel,
  setTrackHeight,
  toggleTrackFlag,
  trimClipEnd,
  trimClipStart,
  unlinkClips,
  updateMarker,
  type TrackFlag,
} from '@nos/editing';
import {
  type GeneratorManifest,
  type RecalledRun,
  type SelectionOutcome,
  isProvenanceRecord,
  placeholderLength,
  provenancePath,
  recallRun,
} from '@nos/generators';
import {
  FilmIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PauseIcon,
  PlayIcon,
  SaveIcon,
  ServerIcon,
  SkipBackIcon,
  KeyboardIcon,
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
import { KeyframeLanes } from './KeyframeLanes.js';
import { ManifestAuthoring } from './ManifestAuthoring.js';
import { createTextClip } from './TextInspector.js';
import { Preview } from './Preview.js';
import { usePlaybackAudio } from './use-audio-engine.js';
import { useTransport, useTransportKeys } from './use-transport.js';
import { playbackEnd, useWorkRange } from './use-work-range.js';
import { describeAutosave, useAutosave } from './use-autosave.js';
import { ModeToggle } from './ModeToggle.js';
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
          setError(describeEditError(result.error));
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
    [confirmation, landVariant, tree],
  );

  /**
   * Which clip's name field should open by itself, for a rename asked for from the timeline's menu.
   *
   * The clip rather than a flag. A boolean stays true after the field closes, so selecting the next
   * clip would open *its* name field uninvited — the rename would follow the user around. Naming the
   * clip makes the offer expire the moment the selection moves, with nothing to clear.
   */
  const [renamingClip, setRenamingClip] = useState<ClipId | undefined>(undefined);

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
  const [rightTab, setRightTab] = useState<PanelTab>('inspector');
  const selectedClip = [...selected][0];
  const masks = useMaskWorkspace(document, selectedClip, playhead, sidecar);
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
  const exportRun = useExportRun({ document, sidecar, masks: maskSource });

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
        case 'delete':
          void files.trash(target.path).then((done) => {
            // The watcher reports the removal, but a rescan makes the row go at once rather than at
            // the next debounce — a file that lingers after "Move to trash" reads as a failure.
            if (done) tree.refresh();
          });
          break;
        default: {
          const unreachable: never = action;
          throw new Error(`Unhandled browser action ${String(unreachable)}`);
        }
      }
    },
    [files, tree],
  );

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
          setRightTab('inspector');
          setRenamingClip(target.clip);
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
    [clipEdits, store],
  );

  /**
   * What the timeline's right-click offers, and what a choice does.
   *
   * One object because the two halves are useless apart, and because the panels render the menu
   * themselves now — this describes it, and `ActionMenu` turns the description into markup.
   */
  const timelineMenu: MenuBinding<TimelineMenuTarget> = useMemo(
    () => ({
      items: (target) =>
        clipMenuItems({
          document,
          clip: target.clip,
          track: target.track,
          selectionSize: selected.size,
          canPaste: clipEdits.canPaste,
          hasAttributes: clipEdits.attributeSummary !== undefined,
          canLink: linkablePair(document, [...selected] as ClipId[]) !== undefined,
          ...(target.track !== undefined
            ? {
                canMoveTrackUp: canMoveTrack(document, target.track, -1),
                canMoveTrackDown: canMoveTrack(document, target.track, 1),
              }
            : {}),
          ripple,
        }),
      onChoose: (target, action) => runClipMenuAction(target, action as ClipMenuAction),
    }),
    [clipEdits, document, ripple, runClipMenuAction, selected],
  );

  /**
   * Everything running, from every source that has any.
   *
   * Assembled here because this is the only place that can see all of them; each is adapted in
   * `activities.ts`, so adding a sixth source changes this list and nothing else.
   */
  const activities = useMemo(
    () =>
      orderActivities([
        ...generatorActivities(runtime.snapshot),
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
      ...(notice !== undefined ? [{ id: 'notice', tone: 'warning' as const, message: notice }] : []),
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
    () => ({
      items: (target) =>
        browserMenuItems({
          path: target.path === '' ? undefined : target.path,
          isDirectory: target.isDirectory,
        }),
      onChoose: (target, action) => runBrowserMenuAction(target, action as BrowserMenuAction),
    }),
    [runBrowserMenuAction],
  );

  return (
    <div className="flex h-screen flex-col">
      <TitleBar
        project={project}
        sidecar={sidecar}
        dirty={store.getSnapshot().dirty}
        onOpen={() => void openProject()}
        onSave={() => void save()}
        onExport={openExport}
        autosaveStatus={autosave.status}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />

      <ShortcutSheet groups={SHORTCUT_GROUPS} open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

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

      {/*
        Three columns and, inside the middle one, two rows — every boundary draggable, and the two side
        panels collapsible to nothing. They were fixed at 280, 340 and 392 pixels, which is a reasonable
        default and a poor rule: a timeline is what you want tall while cutting and short while framing,
        and a browser is what you want gone entirely on a laptop.

        The handles carry a grip, because a boundary that only reveals itself on hover is one nobody
        finds. Where they are left is remembered — a panel a user drags every session is one that
        should have stayed where they put it.
      */}
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
                  onClipPointerDown={(clip, event) => drag.begin(event.altKey ? 'slip' : 'move', clip, event)}
                  // Shift rolls the cut instead of trimming one side of it: the outgoing clip gains
                  // exactly what the incoming one gives up, so nothing downstream moves. It is the edit
                  // an editor reaches for constantly — the cut is a frame late, so you move the cut.
                  onTrimStart={(clip, event) =>
                    drag.begin(event.shiftKey ? 'roll' : 'trim-start', clip, event)
                  }
                  onTrimEnd={(clip, event) => drag.begin(event.shiftKey ? 'roll' : 'trim-end', clip, event)}
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
            projectTree={tree.tree}
            masks={masks}
            maskChoices={maskChoices}
            tab={rightTab}
            onTabChange={setRightTab}
            recalled={recalled}
            effectProblems={effects.problems}
            onRenameClip={renameClip}
            renamingClip={renamingClip !== undefined && renamingClip === [...selected][0]}
            document={document}
            effects={effectRegistry}
            onChangeDocument={commitDocument}
            registry={library.registry}
            libraryProblems={library.problems}
            libraryPath={library.libraryPath}
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
        </ResizablePanel>
      </ResizablePanelGroup>

      <StatusBar activities={activities} notices={notices}>
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
  onSave,
  onExport,
  autosaveStatus,
  onShowShortcuts,
}: {
  readonly project: ProjectInfo | undefined;
  readonly sidecar: SidecarInfo | undefined;
  readonly dirty: boolean;
  readonly onOpen: () => void;
  readonly onSave: () => void;
  readonly onExport: () => void;
  readonly autosaveStatus: AutosaveStatus;
  readonly onShowShortcuts: () => void;
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
        className={cn('ml-auto font-mono', sidecar?.available === true && 'text-chart-2')}
        title={sidecar?.detail ?? ''}
      >
        <ServerIcon />
        {sidecar === undefined ? 'sidecar idle' : sidecar.available ? 'sidecar ready' : 'sidecar unavailable'}
      </Badge>
      {project !== undefined && <AutosaveChip status={autosaveStatus} />}
      {/* A button as well as the `?` chord, because a reference reachable only by a shortcut is one
          only the people who do not need it can open. */}
      <Button variant="ghost" size="icon-sm" onClick={onShowShortcuts} title="Keyboard and pointer (?)">
        <KeyboardIcon />
        <span className="sr-only">Keyboard and pointer</span>
      </Button>
      <ModeToggle />
      <Separator orientation="vertical" className="h-4" />
      <Button variant="ghost" size="sm" onClick={onOpen}>
        <FolderOpenIcon />
        Open project
      </Button>
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
