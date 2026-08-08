import type { AssetPath, ContentHash, FrameCount, FrameRate, Result } from '@nos/core';
import type { AssetType } from './media-kind.js';

/**
 * Media inspection.
 *
 * The probe is the only authority on what a file actually contains. Extension-based
 * classification is a label for the browser; this is what the timeline trusts, and it is
 * what settles the cases the extension cannot — a `.mov` holding audio only, a variable
 * frame rate file, a video whose container reports a different rate than its stream.
 */

export interface VideoStreamInfo {
  readonly width: number;
  readonly height: number;
  /** Exact, as a rational — `30000/1001`, never `29.97`. */
  readonly frameRate: FrameRate;
  /** Total frames at the stream's own rate. */
  readonly frames: FrameCount;
  readonly codec: string;
  /**
   * Display rotation from container metadata, in degrees.
   *
   * Phone footage is routinely stored landscape with a rotation flag. Ignoring it means the
   * clip renders sideways, so it is surfaced here rather than left to the decoder.
   */
  readonly rotation: number;
  /**
   * Pixel aspect ratio, if the container declares a non-square one.
   *
   * The spec puts colour management out of scope but says nothing about anamorphic; a
   * non-square value is recorded so the compositor can at least letterbox correctly rather
   * than silently stretching.
   */
  readonly pixelAspect?: number;
  /**
   * True when the source has no constant frame rate.
   *
   * Frame-exact editing of a VFR source is not meaningful, so the importer transcodes it to
   * the project rate rather than pretending an index maps to a source frame.
   */
  readonly variableFrameRate: boolean;
}

export interface AudioStreamInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly codec: string;
  /** Total sample frames, at `sampleRate`. */
  readonly samples: number;
}

export interface ImageInfo {
  readonly width: number;
  readonly height: number;
  readonly codec: string;
}

/**
 * What a probe found.
 *
 * A file may carry both video and audio; `type` records what the file *is* for UI purposes
 * while the stream fields record what it *has*. A video with an audio stream produces two
 * linked clips on import, which is why both are kept rather than collapsed.
 */
export interface MediaMetadata {
  readonly asset: AssetPath;
  readonly type: AssetType;
  /** Content hash of the bytes. Every derived-artifact cache key is built from this. */
  readonly hash: ContentHash;
  readonly sizeBytes: number;
  /** Wall-clock duration in seconds. Present for timed media only. */
  readonly durationSeconds?: number;
  readonly video?: VideoStreamInfo;
  readonly audio?: AudioStreamInfo;
  readonly image?: ImageInfo;
}

export type ProbeError =
  | { readonly kind: 'not-found'; readonly asset: AssetPath }
  | { readonly kind: 'unsupported'; readonly asset: AssetPath; readonly detail: string }
  | { readonly kind: 'corrupt'; readonly asset: AssetPath; readonly detail: string }
  | { readonly kind: 'sidecar-unavailable'; readonly detail: string };

/**
 * Reads metadata for an asset.
 *
 * An interface because there will be more than one implementation: the ffprobe-backed
 * sidecar in production, and an in-memory fake in tests. Nothing above this layer should
 * know that ffprobe exists.
 */
export interface MediaProber {
  probe(asset: AssetPath): Promise<Result<MediaMetadata, ProbeError>>;
}

export function describeProbeError(error: ProbeError): string {
  switch (error.kind) {
    case 'not-found':
      return `${error.asset} no longer exists`;
    case 'unsupported':
      return `${error.asset} is not a supported media file: ${error.detail}`;
    case 'corrupt':
      return `${error.asset} could not be read: ${error.detail}`;
    case 'sidecar-unavailable':
      return `The media service is not running: ${error.detail}`;
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled probe error ${JSON.stringify(unreachable)}`);
    }
  }
}

export function hasVideo(
  metadata: MediaMetadata,
): metadata is MediaMetadata & { readonly video: VideoStreamInfo } {
  return metadata.video !== undefined;
}

export function hasAudio(
  metadata: MediaMetadata,
): metadata is MediaMetadata & { readonly audio: AudioStreamInfo } {
  return metadata.audio !== undefined;
}

/**
 * Display dimensions, with container rotation applied.
 *
 * A 90° or 270° rotation swaps width and height. Every consumer that lays out a preview or
 * chooses a proxy size needs the *displayed* size, so the swap happens once, here.
 */
export function displayDimensions(
  info: VideoStreamInfo,
): { readonly width: number; readonly height: number } {
  const quarterTurns = Math.round(info.rotation / 90);
  const swapped = Math.abs(quarterTurns) % 2 === 1;
  return swapped
    ? { width: info.height, height: info.width }
    : { width: info.width, height: info.height };
}

/** `1920×1080 · 29.97 · 00:00:42:11`-style summary for the browser's detail pane. */
export function summarizeMetadata(metadata: MediaMetadata): string {
  if (metadata.video !== undefined) {
    const { width, height } = displayDimensions(metadata.video);
    return `${width}×${height} · ${metadata.video.codec}`;
  }
  if (metadata.audio !== undefined) {
    const channels = metadata.audio.channels === 1 ? 'mono' : `${metadata.audio.channels} ch`;
    return `${metadata.audio.sampleRate} Hz · ${channels} · ${metadata.audio.codec}`;
  }
  if (metadata.image !== undefined) {
    return `${metadata.image.width}×${metadata.image.height} · ${metadata.image.codec}`;
  }
  return metadata.type;
}
