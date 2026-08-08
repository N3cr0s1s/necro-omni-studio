import type { AssetPath, ClipId, FrameIndex, FrameSpan } from '@nos/core';

/**
 * The mask model.
 *
 * The spec's position, and the one thing that keeps this subsystem from becoming a special case: **a mask
 * is an asset type like any other**. It has an importer, it lives in the project folder, and it reaches an
 * effect through a declared `mask` sampler slot. There is no SAM-specific effect code anywhere, and
 * nothing in the compositor knows what produced a mask.
 *
 * What follows from that: this package models masks and segmentation *sessions*, and knows nothing about
 * SAM 2. The engine is an interface (`contracts/segmenter.ts`), so a different segmenter — or a ComfyUI
 * graph doing the same job — replaces it without touching a line here.
 */

/** Identifies a mask track: one tracked object over one clip's range. */
export type MaskTrackId = string & { readonly __brand: 'MaskTrackId' };

export function maskTrackId(value: string): MaskTrackId {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error('MaskTrackId must not be empty');
  return trimmed as MaskTrackId;
}

/**
 * A user's instruction about what to segment.
 *
 * Points carry a label because SAM-family models need negatives: "this, but not that" is what separates a
 * person from the wall behind them, and a UI offering only positive clicks makes the common case
 * impossible.
 */
export type MaskPrompt =
  | {
      readonly kind: 'point';
      readonly frame: FrameIndex;
      /** Normalized `[0, 1]` against the source resolution, so a proxy and a master agree. */
      readonly x: number;
      readonly y: number;
      readonly include: boolean;
    }
  | {
      readonly kind: 'box';
      readonly frame: FrameIndex;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

export type MaskStatus = 'empty' | 'pending' | 'ready' | 'stale' | 'failed';

export interface MaskTrack {
  readonly id: MaskTrackId;
  readonly clip: ClipId;
  /** Frames the mask covers, in clip-source frames. */
  readonly range: FrameSpan;
  readonly prompts: readonly MaskPrompt[];
  readonly status: MaskStatus;
  /** Where the cached frames live, project-relative, under `masks/`. */
  readonly cache?: AssetPath;
  /** Why it failed, for the greyed-with-a-reason rule this project applies everywhere. */
  readonly error?: string;
  readonly label?: string;
}

/** A single frame's mask, run-length encoded. */
export interface MaskFrame {
  readonly frame: FrameIndex;
  readonly width: number;
  readonly height: number;
  /** Column-major run lengths starting from a zero run, as COCO encodes them. */
  readonly counts: readonly number[];
}

export function emptyTrack(id: MaskTrackId, clip: ClipId, range: FrameSpan): MaskTrack {
  return { id, clip, range, prompts: [], status: 'empty' };
}

/**
 * Whether a track's cached masks still match its prompts.
 *
 * `stale` rather than silently re-running: propagation over a long range is expensive, and a UI that
 * re-segments on every click would be unusable. The user sees that the result is out of date and asks for
 * it when ready.
 */
export function withPrompt(track: MaskTrack, prompt: MaskPrompt): MaskTrack {
  return {
    ...track,
    prompts: [...track.prompts, prompt],
    status: track.status === 'ready' ? 'stale' : track.status,
  };
}

export function withoutPrompt(track: MaskTrack, index: number): MaskTrack {
  if (index < 0 || index >= track.prompts.length) return track;
  const prompts = track.prompts.filter((_, position) => position !== index);
  return {
    ...track,
    prompts,
    status: prompts.length === 0 ? 'empty' : track.status === 'ready' ? 'stale' : track.status,
  };
}

/** Prompts placed on one frame, which is what an engine is given for its first pass. */
export function promptsAt(track: MaskTrack, frame: FrameIndex): readonly MaskPrompt[] {
  return track.prompts.filter((prompt) => prompt.frame === frame);
}

/** Frames carrying at least one prompt, in order — the propagation anchors. */
export function anchorFrames(track: MaskTrack): readonly FrameIndex[] {
  const frames = [...new Set(track.prompts.map((prompt) => prompt.frame))];
  return frames.sort((a, b) => a - b);
}

/** One line describing a track's state, so the wording is asserted once. */
export function describeTrack(track: MaskTrack): string {
  switch (track.status) {
    case 'empty':
      return 'click the object to start';
    case 'pending':
      return 'segmenting';
    case 'ready':
      return `${track.prompts.length} prompt${track.prompts.length === 1 ? '' : 's'}`;
    case 'stale':
      return 'prompts changed — re-run to update';
    case 'failed':
      return track.error ?? 'segmentation failed';
    default: {
      const unreachable: never = track.status;
      throw new Error(`Unhandled status ${String(unreachable)}`);
    }
  }
}
