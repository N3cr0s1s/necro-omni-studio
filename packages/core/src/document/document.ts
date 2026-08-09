import { type FrameRate } from '../time/frame-rate.js';
import { type FrameCount, type FrameIndex, frameCount, frameIndex } from '../time/frame-time.js';
import { type FrameSpan } from '../time/frame-span.js';
import type { StoryBeat } from './story.js';
import { type Clip, type Transition } from './clip.js';
import {
  type AssetPath,
  type ClipId,
  type MaskId,
  type ProjectId,
  type SequenceId,
  type TrackId,
} from './ids.js';
import { type Track, type TrackKind, trackClips, trackEnd } from './track.js';

/** Output pixel dimensions. Square pixels only — anamorphic is out of scope. */
export interface Resolution {
  readonly width: number;
  readonly height: number;
}

/**
 * A SAM 2 mask, cached on disk and referenced by effects.
 *
 * The mask is deliberately not a special clip kind. It is an addressable asset that any
 * effect declaring a `mask` sampler slot can bind, which is the single seam between
 * segmentation and the effect system.
 */
export interface MaskDefinition {
  readonly id: MaskId;
  /** The clip the mask was authored against. */
  readonly clip: ClipId;
  /** Range the mask was propagated over, in project-rate frames. */
  readonly span: FrameSpan;
  /** Cache location under `masks/`. */
  readonly asset: AssetPath;
  /** Prompt points the user clicked, kept so propagation can be re-run. */
  readonly points: readonly MaskPoint[];
}

export interface MaskPoint {
  /** Frame the point was placed on. */
  readonly frame: FrameIndex;
  /** Normalized `[0, 1]` position within the frame. */
  readonly x: number;
  readonly y: number;
  /** Negative points carve away from the selection. */
  readonly include: boolean;
}

/**
 * A named position or range on the timeline.
 *
 * In/out points are markers rather than separate fields so that adding chapter markers
 * later needs no schema change.
 */
export interface Marker {
  readonly frame: FrameIndex;
  readonly label: string;
  readonly color?: string;
}

export interface Sequence {
  readonly id: SequenceId;
  readonly tracks: readonly Track[];
  /**
   * The in/out range. Bounds looped playback and is the default export range; absent
   * means the whole sequence.
   */
  readonly workRange?: FrameSpan;
  readonly markers: readonly Marker[];
}

/**
 * The timeline document — everything `project.json` holds.
 *
 * Deliberately a plain immutable data structure with no methods and no identity beyond
 * its ids. Every mutation goes through the patch engine, which is what makes undo/redo
 * and autosave uniform instead of per-feature.
 */
export interface TimelineDocument {
  /** Bumped whenever the on-disk shape changes; drives the migration chain. */
  readonly schemaVersion: number;
  readonly id: ProjectId;
  readonly name: string;
  /** The project rate. Every frame index in the document is at this rate. */
  readonly frameRate: FrameRate;
  readonly resolution: Resolution;
  readonly sequence: Sequence;
  readonly masks: readonly MaskDefinition[];
  /**
   * The story board: what is meant to happen, on the same clock as the cut.
   *
   * Issue #33. In the document rather than beside it, because intent that lives outside the project
   * goes stale the first time the folder moves — and because undo, autosave and crash recovery are
   * already uniform here and a plan stored anywhere else would need its own answer to all three.
   */
  readonly story: readonly StoryBeat[];
}

/** Current on-disk schema version. */
export const SCHEMA_VERSION = 1;

/** Effect passes above this earn a warning, per the spec's non-functional budget. */
export const PASS_WARNING_THRESHOLD = 8;

export function findTrack(document: TimelineDocument, id: TrackId): Track | undefined {
  return document.sequence.tracks.find((track) => track.id === id);
}

export function tracksOfKind(document: TimelineDocument, kind: TrackKind): readonly Track[] {
  return document.sequence.tracks.filter((track) => track.kind === kind);
}

/** Locates a clip anywhere in the document, with the track that holds it. */
export function locateClip(
  document: TimelineDocument,
  id: ClipId,
): { readonly track: Track; readonly clip: Clip } | undefined {
  for (const track of document.sequence.tracks) {
    const clip = trackClips(track).find((candidate) => candidate.id === id);
    if (clip !== undefined) return { track, clip };
  }
  return undefined;
}

export function allClips(document: TimelineDocument): readonly Clip[] {
  return document.sequence.tracks.flatMap((track) => trackClips(track));
}

export function allTransitions(document: TimelineDocument): readonly Transition[] {
  return document.sequence.tracks.flatMap((track) => (track.kind === 'video' ? track.transitions : []));
}

export function clipCount(document: TimelineDocument): number {
  return allClips(document).length;
}

/** First frame after the last clip on any track. */
export function documentEnd(document: TimelineDocument): FrameIndex {
  let end = 0;
  for (const track of document.sequence.tracks) {
    const trackLast = trackEnd(track);
    if (trackLast > end) end = trackLast;
  }
  return frameIndex(end);
}

export function documentDuration(document: TimelineDocument): FrameCount {
  return frameCount(documentEnd(document));
}

/** True when any track is soloed, which flips every other track to silent. */
export function anySoloed(document: TimelineDocument): boolean {
  return document.sequence.tracks.some((track) => track.solo);
}

export function findMask(document: TimelineDocument, id: MaskId): MaskDefinition | undefined {
  return document.masks.find((mask) => mask.id === id);
}

export function masksForClip(document: TimelineDocument, clip: ClipId): readonly MaskDefinition[] {
  return document.masks.filter((mask) => mask.clip === clip);
}

/**
 * The range to render, honouring the in/out points.
 *
 * Falls back to the whole sequence when no work range is set, so export and loop
 * playback share one definition instead of each inventing a default.
 */
export function renderRange(document: TimelineDocument): FrameSpan {
  const workRange = document.sequence.workRange;
  if (workRange !== undefined) return workRange;
  return { start: frameIndex(0), duration: documentDuration(document) };
}

/** Assets the document references, deduplicated — the set a project archive must carry. */
export function referencedAssets(document: TimelineDocument): readonly AssetPath[] {
  const assets = new Set<AssetPath>();
  for (const clip of allClips(document)) {
    if (clip.kind !== 'text') assets.add(clip.source.asset);
  }
  for (const mask of document.masks) {
    assets.add(mask.asset);
  }
  return [...assets];
}

/**
 * Creates an empty document with the conventional starting track layout.
 *
 * A new project opens with V1/A1/T1 rather than nothing, because the first action in an
 * empty editor is always "make somewhere to put this".
 */
export interface CreateDocumentOptions {
  readonly id: ProjectId;
  readonly sequenceId: SequenceId;
  readonly name: string;
  readonly frameRate: FrameRate;
  readonly resolution: Resolution;
  readonly trackIds: {
    readonly video: TrackId;
    readonly audio: TrackId;
    readonly text: TrackId;
  };
}

export const DEFAULT_TRACK_HEIGHTS: Readonly<Record<TrackKind, number>> = {
  video: 84,
  audio: 60,
  text: 46,
};

export function createDocument(options: CreateDocumentOptions): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: options.id,
    name: options.name,
    frameRate: options.frameRate,
    resolution: options.resolution,
    masks: [],
    // No plan yet, which is a different thing from no story: a board is written, not derived.
    story: [],
    sequence: {
      id: options.sequenceId,
      markers: [],
      tracks: [
        {
          kind: 'video',
          id: options.trackIds.video,
          name: 'V1',
          muted: false,
          solo: false,
          locked: false,
          height: DEFAULT_TRACK_HEIGHTS.video,
          collapsed: false,
          clips: [],
          transitions: [],
        },
        {
          kind: 'audio',
          id: options.trackIds.audio,
          name: 'A1',
          muted: false,
          solo: false,
          locked: false,
          height: DEFAULT_TRACK_HEIGHTS.audio,
          collapsed: false,
          clips: [],
          gain: 1,
          pan: 0,
        },
        {
          kind: 'text',
          id: options.trackIds.text,
          name: 'T1',
          muted: false,
          solo: false,
          locked: false,
          height: DEFAULT_TRACK_HEIGHTS.text,
          collapsed: false,
          clips: [],
        },
      ],
    },
  };
}
