import {
  type AssetPath,
  type AudioClip,
  type Clip,
  type ClipId,
  type FrameIndex,
  type FrameRate,
  type GeneratorProvenance,
  type ImageClip,
  type Result,
  type TimelineDocument,
  type Track,
  type TrackId,
  type TrackKind,
  type VideoClip,
  DEFAULT_TRACK_HEIGHTS,
  endExclusive,
  err,
  frameIndex,
  ok,
  overlaps,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import type { EditError } from './errors.js';
import { addClipToTrack, replaceTrack } from './mutate.js';

/**
 * Landing generator output on the timeline.
 *
 * The last step of the spec's generative loop: a variant the user accepted becomes an ordinary clip,
 * carrying the provenance that makes it reproducible and colours it as generated.
 *
 * The insertion rule is not one rule but two, and the spec is explicit about why:
 *
 * - A **declared**-length generator was sized before the job ran, so its placeholder already occupies
 *   the right span. It lands exactly where it was staged, and a collision is a rejection like any other.
 * - A **discovered**-length generator — text-to-speech, stem separation — only reveals its length in the
 *   output. It lands from the playhead and **later clips must not shift**: a narration that rearranged a
 *   video cut would be the single most destructive thing this feature could do. If it collides, it moves
 *   to the next free track of its kind, creating one if necessary.
 *
 * Pure, like every other operation here: no I/O, no clock, no id generation. The caller supplies the id
 * and the timestamp, which is what keeps this testable and the result reproducible.
 */

export type DurationMode = 'declared' | 'discovered';

export interface InsertGeneratedRequest {
  /** Where the file landed, project-relative. */
  readonly asset: AssetPath;
  readonly kind: Exclude<TrackKind, 'text'>;
  /** Rate the output was produced at. Kept on the clip so a retime is exact. */
  readonly sourceRate: FrameRate;
  readonly length: number;
  readonly at: FrameIndex;
  /** Preferred track. A discovered-length insert may land elsewhere; a declared one may not. */
  readonly track: TrackId;
  readonly duration: DurationMode;
  readonly id: ClipId;
  readonly label: string;
  readonly provenance: GeneratorProvenance;
  /** Ids for tracks this may need to create, in order. Supplied so the operation stays pure. */
  readonly spareTrackIds?: readonly TrackId[];
}

export interface InsertGeneratedResult {
  readonly document: TimelineDocument;
  readonly clip: Clip;
  /** The track it actually landed on, which is not always the one requested. */
  readonly track: TrackId;
  /** True when a new track had to be created to avoid shifting existing clips. */
  readonly createdTrack: boolean;
}

export function insertGenerated(
  document: TimelineDocument,
  request: InsertGeneratedRequest,
): Result<InsertGeneratedResult, EditError> {
  if (request.length <= 0) return err({ kind: 'empty-result', clip: request.id });

  const span = spanFromBounds(request.at, frameIndex(request.at + request.length));
  const clip = buildClip(request, span);

  const requested = document.sequence.tracks.find((track) => track.id === request.track);
  if (requested === undefined) return err({ kind: 'track-not-found', track: request.track });
  if (requested.kind !== request.kind) {
    return err({
      kind: 'wrong-track-kind',
      track: request.track,
      accepts: [requested.kind],
      received: request.kind,
    });
  }

  if (!isOccupied(requested, span)) {
    if (requested.locked) return err({ kind: 'track-locked', track: requested.id });
    return ok({
      document: replaceTrack(document, addClipToTrack(requested, clip)),
      clip,
      track: requested.id,
      createdTrack: false,
    });
  }

  // A declared-length insert was staged at a position the user could see, so a collision there is a
  // genuine conflict and is reported rather than worked around.
  if (request.duration === 'declared') {
    const blocking = clipsIn(requested).find((existing) => overlaps(existing.span, span));
    return err({
      kind: 'collision',
      track: requested.id,
      withClip: blocking?.id ?? request.id,
    });
  }

  // Discovered length: find another track of the same kind with room, rather than moving anything.
  const free = document.sequence.tracks.find(
    (track) => track.kind === request.kind && !track.locked && !isOccupied(track, span),
  );
  if (free !== undefined) {
    return ok({
      document: replaceTrack(document, addClipToTrack(free, clip)),
      clip,
      track: free.id,
      createdTrack: false,
    });
  }

  const created = newTrack(document, request);
  if (created === undefined) return err({ kind: 'track-not-found', track: request.track });

  return ok({
    document: {
      ...document,
      sequence: {
        ...document.sequence,
        tracks: [...document.sequence.tracks, addClipToTrack(created, clip)],
      },
    },
    clip,
    track: created.id,
    createdTrack: true,
  });
}

/** Clips on a track, regardless of which kind of track it is. */
function clipsIn(track: Track): readonly Clip[] {
  return track.clips as readonly Clip[];
}

function isOccupied(track: Track, span: ReturnType<typeof spanFromBounds>): boolean {
  return clipsIn(track).some((clip) => overlaps(clip.span, span));
}

/**
 * A new track for output that has nowhere to go.
 *
 * Named by kind and ordinal — `A2`, `A3` — matching what the user already sees on the existing tracks,
 * because a track appearing with a generated name would read as something the application did to them
 * rather than something they asked for.
 */
function newTrack(document: TimelineDocument, request: InsertGeneratedRequest): Track | undefined {
  const sameKind = document.sequence.tracks.filter((track) => track.kind === request.kind);
  const ordinal = sameKind.length + 1;
  const prefix = request.kind === 'video' ? 'V' : 'A';

  const id =
    request.spareTrackIds?.[0] ??
    (() => {
      const candidate = `${prefix}${ordinal}`;
      // Falls back only when the caller supplied nothing; a collision here would replace a track.
      return document.sequence.tracks.some((track) => track.id === candidate)
        ? `${prefix}${ordinal}_generated`
        : candidate;
    })();

  const base = {
    id: trackId(id),
    name: `${prefix}${ordinal}`,
    muted: false,
    solo: false,
    locked: false,
    height: DEFAULT_TRACK_HEIGHTS[request.kind],
    collapsed: false,
    clips: [],
  } as const;

  return request.kind === 'video'
    ? { ...base, kind: 'video', transitions: [] }
    : // Unity gain, centred: a new track must not alter what the material sounds like, and a default the
      // user did not choose is a bug they will chase in the mixer.
      { ...base, kind: 'audio', gain: 1, pan: 0 };
}

function buildClip(request: InsertGeneratedRequest, span: ReturnType<typeof spanFromBounds>): Clip {
  const source = { asset: request.asset, sourceIn: frameIndex(0), sourceRate: request.sourceRate };
  const common = {
    id: request.id,
    span,
    label: request.label,
    enabled: true,
    effects: [],
    provenance: request.provenance,
  };

  if (request.kind === 'audio') {
    return {
      ...common,
      kind: 'audio',
      source,
      speed: { factor: 1, preservePitch: true },
      gain: staticNumber(1),
      pan: staticNumber(0),
    } satisfies AudioClip;
  }

  return {
    ...common,
    kind: 'video',
    source,
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
  } satisfies VideoClip;
}

/** Where a discovered-length insert would land, for showing it before it happens. */
export function previewInsertTrack(
  document: TimelineDocument,
  request: Pick<InsertGeneratedRequest, 'kind' | 'at' | 'length' | 'track' | 'duration'>,
): { readonly track: TrackId | undefined; readonly createsTrack: boolean } {
  const span = spanFromBounds(request.at, frameIndex(request.at + Math.max(1, request.length)));
  const requested = document.sequence.tracks.find((track) => track.id === request.track);

  if (requested !== undefined && requested.kind === request.kind && !isOccupied(requested, span)) {
    return { track: requested.id, createsTrack: false };
  }
  if (request.duration === 'declared') return { track: undefined, createsTrack: false };

  const free = document.sequence.tracks.find(
    (track) => track.kind === request.kind && !track.locked && !isOccupied(track, span),
  );
  return free === undefined
    ? { track: undefined, createsTrack: true }
    : { track: free.id, createsTrack: false };
}

/** The last frame any clip reaches on a track, for appending after existing material. */
export function trackEnd(track: Track): FrameIndex {
  let end = 0;
  for (const clip of clipsIn(track)) end = Math.max(end, endExclusive(clip.span));
  return frameIndex(end);
}

export type { ImageClip };
