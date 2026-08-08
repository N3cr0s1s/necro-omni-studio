import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AssetPath,
  type ClipId,
  type FrameIndex,
  type FrameSpan,
  type TimelineDocument,
  clipId,
  locateClip,
} from '@nos/core';
import {
  type MaskPrompt,
  type MaskSession,
  type SegmentationCapabilities,
  addPrompt,
  beginSession,
  emptyTrack,
  maskTrackId,
  moveTo,
  removePrompt,
  createMaskCache,
  setPropagation,
} from '@nos/masks';
import type { DesktopBridge, SidecarInfo } from '../main/ipc-contract.js';
import { createBridgeMaskStorage } from './mask-storage.js';
import type { GpuSemaphore } from '@nos/generators';
import { useSegmentation } from './use-segmentation.js';

/**
 * The mask session for the selected clip, and everything that acts on it.
 *
 * Held above both panels that need it. The *points* are placed on the preview and the run is started
 * from the inspector, and those are siblings — a session owned by either could not be drawn by the
 * other, and one on each side would disagree the moment either was edited.
 *
 * Sessions are kept per clip rather than replaced, which is the difference between a panel you can
 * use and one you cannot: a session rebuilt from the clip on every render — as it was — discarded
 * every placed point each time the playhead moved, so a second point could never be added.
 */

export interface MaskWorkspace {
  /** The selected clip's session, or `undefined` when nothing that can be masked is selected. */
  readonly session: MaskSession | undefined;
  readonly capabilities: SegmentationCapabilities | undefined;
  readonly error: string | undefined;
  addPrompt(prompt: MaskPrompt): void;
  removePrompt(index: number): void;
  setPropagation(span: FrameSpan): void;
  run(source: AssetPath): void;
  cancel(): void;
}

export function useMaskWorkspace(
  document: TimelineDocument,
  selectedClip: string | undefined,
  playhead: FrameIndex,
  sidecar: SidecarInfo | undefined,
  /**
   * The window's GPU semaphore, so a propagation serializes against generations.
   *
   * Passed in rather than created here: the spec's rule is *one* semaphore for every consumer, and a
   * second instance would serialize segmentation against nothing but itself while still looking, from
   * every status readout, exactly like a working lock.
   */
  gpu: GpuSemaphore,
  /**
   * How the cache reaches the project folder.
   *
   * Passed in rather than reached for, so this hook stays testable without a shell — and so a build
   * with no bridge at all degrades to masks that live only in memory rather than throwing.
   */
  bridge: () => DesktopBridge | undefined = () => (globalThis as { nos?: DesktopBridge }).nos,
): MaskWorkspace {
  const [sessions, setSessions] = useState<ReadonlyMap<string, MaskSession>>(new Map());
  /** Clips whose cache has been read this session, so a select does not re-read on every render. */
  const loaded = useRef<Set<string>>(new Set());
  /** The run whose result is waiting to be written, set when it starts and cleared when it lands. */
  const pendingSave = useRef<{ clip: ClipId; source: AssetPath } | undefined>(undefined);
  const cache = useMemo(() => createMaskCache(createBridgeMaskStorage(bridge)), [bridge]);

  const located = useMemo(
    () => (selectedClip === undefined ? undefined : locateClip(document, clipId(selectedClip))),
    [document, selectedClip],
  );

  /**
   * Writes a finished run to `masks/`.
   *
   * Keyed on the run that produced it, so a session whose prompts have since changed cannot be saved
   * under the old key — the cache's whole guarantee is that a hit means "these prompts, this range,
   * this source", and a late write would break it.
   */
  useEffect(() => {
    const pending = pendingSave.current;
    if (pending === undefined) return;

    const current = sessions.get(pending.clip);
    if (current === undefined || current.running || current.frames.size === 0) return;

    pendingSave.current = undefined;
    void cache.save(current.track, pending.source, [...current.frames.values()]);
  }, [cache, sessions]);

  const session = useMemo(() => {
    if (selectedClip === undefined || located === undefined) return undefined;
    const existing = sessions.get(selectedClip);
    // The clip's *own* range, not a fixed length. Propagating over a span the clip does not cover
    // produces masks for frames it never shows — pure cost, invisible result.
    const base =
      existing ??
      beginSession(
        emptyTrack(maskTrackId(`${selectedClip}-mask`), clipId(selectedClip), located.clip.span),
        playhead,
      );
    // The session follows the playhead so a point lands on the frame being looked at, but the frame
    // is the only thing that follows it — everything else the user has placed stays.
    return base.frame === playhead ? base : moveTo(base, playhead);
  }, [located, playhead, selectedClip, sessions]);

  const update = useCallback(
    (change: (current: MaskSession) => MaskSession) => {
      setSessions((current) => {
        const key = selectedClip;
        if (key === undefined || session === undefined) return current;
        const next = new Map(current);
        next.set(key, change(current.get(key) ?? session));
        return next;
      });
    },
    [selectedClip, session],
  );

  const segmentation = useSegmentation(sidecar, update, gpu);

  /**
   * The source a clip's masks are keyed against.
   *
   * Part of the cache key, so a mask cut from one take is never served for another — which is what
   * makes the key content-addressed rather than merely a clip id.
   */
  const source = located?.clip.kind === 'video' ? located.clip.source.asset : undefined;

  /**
   * Reads a clip's masks back from `masks/` the first time it is selected.
   *
   * Without this the cache was write-only in effect: a project reopened the next morning had an effect
   * bound to a mask that existed on disk and in no session, so it rendered unmasked — which reads as
   * the mask being wrong rather than as the mask not being loaded.
   *
   * Runs once per clip, guarded by whether a session already exists rather than by a flag: a session
   * that has been run has frames of its own, and re-reading over them would discard work.
   */
  useEffect(() => {
    const key = selectedClip;
    if (key === undefined || source === undefined || session === undefined) return;
    if (session.frames.size > 0 || loaded.current.has(key)) return;

    loaded.current.add(key);
    let cancelled = false;

    void cache.load(session.track, source).then((frames) => {
      // Nothing cached is the common case and not worth a state update: an empty map replacing an
      // empty map would re-render every panel bound to the session.
      if (cancelled || frames.length === 0) return;
      setSessions((current) => {
        const existing = current.get(key);
        if (existing === undefined || existing.frames.size > 0) return current;
        const next = new Map(current);
        next.set(key, { ...existing, frames: new Map(frames.map((frame) => [frame.frame, frame])) });
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [cache, selectedClip, session, source]);

  return {
    session,
    capabilities: segmentation.capabilities,
    error: segmentation.error,
    addPrompt: useCallback((prompt: MaskPrompt) => update((current) => addPrompt(current, prompt)), [update]),
    removePrompt: useCallback((index: number) => update((current) => removePrompt(current, index)), [update]),
    setPropagation: useCallback(
      (span: FrameSpan) => update((current) => setPropagation(current, span)),
      [update],
    ),
    run: useCallback(
      (asset: AssetPath) => {
        if (session === undefined) return;
        segmentation.run(session, asset);
        // Saved when the run reports it is finished rather than here: the frames do not exist yet, and
        // writing a partial set under a key that says "these prompts, this range" would turn a
        // cancelled run into a cache hit that is quietly incomplete.
        pendingSave.current = { clip: session.track.clip, source: asset };
      },
      [segmentation, session],
    ),
    cancel: segmentation.cancel,
  };
}

/** The clip a mask session belongs to, for a caller that needs the source it was cut from. */
export function maskedClip(session: MaskSession | undefined): ClipId | undefined {
  return session?.track.clip;
}
