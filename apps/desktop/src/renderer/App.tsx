import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ClipId,
  type FrameIndex,
  type TimelineDocument,
  FRAME_RATES,
  createDocument,
  createDocumentStore,
  frameIndex,
  loadDocument,
  locateClip,
  projectId,
  saveDocument,
  sequenceId,
  trackId,
} from '@nos/core';
import { buildTree } from '@nos/media';
import { moveClip, splitClip, trimClipEnd, trimClipStart } from '@nos/editing';
import { Button, MediaBrowser, Timeline, createViewport } from '@nos/ui';
import type { DesktopBridge, ProjectInfo, SidecarInfo } from '../main/ipc-contract.js';
import { Preview } from './Preview.js';
import { useClipDrag } from './use-clip-drag.js';
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
  const [playhead, setPlayhead] = useState<FrameIndex>(frameIndex(0));
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

  const commitDocument = useCallback(
    (label: string, next: TimelineDocument) => {
      store.commit(label, () => next);
    },
    [store],
  );

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
  }, [project, store]);

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
        onOpen={() => void openProject()}
        onSave={() => void save()}
      />

      {(error ?? drag.rejection) !== undefined && (
        <div
          role="alert"
          style={{
            padding: '6px 16px',
            background: 'rgba(255, 107, 107, 0.12)',
            color: 'var(--nos-danger)',
            font: '500 11px ui-monospace, monospace',
          }}
        >
          {error ?? drag.rejection}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <MediaBrowser tree={tree.tree ?? buildTree([])} watcher={tree.watcher} onActivate={() => undefined} />

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Preview document={drag.document} frame={playhead} sidecar={sidecar} />

          <div ref={laneRef} style={{ flex: 'none' }}>
            <Timeline
              document={drag.document}
              viewport={viewport}
              playhead={playhead}
              selectedClips={selected}
              snapEnabled={snap}
              rippleEnabled={ripple}
              onScrub={setPlayhead}
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
          </div>
        </main>

        <RightPanel
          registry={library.registry}
          libraryProblems={library.problems}
          runtime={runtime}
          playhead={playhead}
          selectedClip={[...selected][0]}
          canUndo={store.getSnapshot().canUndo}
          canRedo={store.getSnapshot().canRedo}
          onSplit={razor}
          onNudge={nudge}
          onUndo={() => store.undo()}
          onRedo={() => store.redo()}
        />
      </div>
    </div>
  );
}

function TitleBar({
  project,
  sidecar,
  dirty,
  onOpen,
  onSave,
}: {
  readonly project: ProjectInfo | undefined;
  readonly sidecar: SidecarInfo | undefined;
  readonly dirty: boolean;
  readonly onOpen: () => void;
  readonly onSave: () => void;
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
      <Button onClick={onOpen}>Open project</Button>
      <Button tone="primary" onClick={onSave} disabled={project === undefined}>
        Save
      </Button>
    </header>
  );
}

function describeEdit(error: { readonly kind: string }): string {
  return `the edit was rejected: ${error.kind.replace(/-/g, ' ')}`;
}

export { trimClipEnd, trimClipStart };
