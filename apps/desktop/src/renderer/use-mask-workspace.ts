import { useCallback, useMemo, useState } from 'react';
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
  setPropagation,
} from '@nos/masks';
import type { SidecarInfo } from '../main/ipc-contract.js';
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
): MaskWorkspace {
  const [sessions, setSessions] = useState<ReadonlyMap<string, MaskSession>>(new Map());

  const located = useMemo(
    () => (selectedClip === undefined ? undefined : locateClip(document, clipId(selectedClip))),
    [document, selectedClip],
  );

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

  const segmentation = useSegmentation(sidecar, update);

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
      (source: AssetPath) => {
        if (session !== undefined) segmentation.run(session, source);
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
