import {
  type AssetPath,
  type ContentHash,
  type FrameRate,
  type Result,
  contentHash,
  err,
  frameCount,
  frameIndex,
  ok,
  parseFrameRate,
} from '@nos/core';
import type {
  AssetType,
  DerivationError,
  DerivationOptions,
  DerivedArtifact,
  DerivedArtifactService,
  DerivedSpec,
  MediaMetadata,
  MediaProber,
  ProbeError,
  WaveformPeaks,
  WaveformSpec,
} from '@nos/media';
import { cacheKey } from '@nos/media';
import { type FileEntry } from '@nos/media';
import { decodePeaks, describePeaksError } from './peaks-codec.js';
import { type SidecarTransport, type TransportError } from './transport.js';

/**
 * The sidecar-backed implementation of the media contracts.
 *
 * Every wire payload is translated into domain types at this boundary: rate strings become
 * `FrameRate`, numbers become `FrameIndex`/`FrameCount`, hashes become `ContentHash`. Nothing above
 * this file deals in loose strings, so a rate that failed to parse cannot reach the compositor.
 *
 * Long derivations get generous timeouts rather than none. A hung ffmpeg must eventually surface as
 * an error the UI can show, not as an import spinner that never resolves.
 */

const PROBE_TIMEOUT_MS = 60_000;
const DERIVE_TIMEOUT_MS = 30 * 60_000;

/** Wire shapes, mirroring `apps/sidecar/src/nos_sidecar/models.py`. */
interface WireVideoStream {
  readonly width: number;
  readonly height: number;
  readonly frame_rate: string;
  readonly frames: number;
  readonly codec: string;
  readonly rotation: number;
  readonly pixel_aspect: number | null;
  readonly variable_frame_rate: boolean;
}

interface WireAudioStream {
  readonly sample_rate: number;
  readonly channels: number;
  readonly codec: string;
  readonly samples: number;
}

interface WireImage {
  readonly width: number;
  readonly height: number;
  readonly codec: string;
}

interface WireMetadata {
  readonly asset: string;
  readonly type: AssetType;
  readonly hash: string;
  readonly size_bytes: number;
  readonly duration_seconds: number | null;
  readonly video: WireVideoStream | null;
  readonly audio: WireAudioStream | null;
  readonly image: WireImage | null;
}

interface WireArtifact {
  readonly kind: string;
  readonly key: string;
  readonly path: string;
  readonly reused: boolean;
}

interface WireScanEntry {
  readonly path: string;
  readonly is_directory: boolean;
  readonly size_bytes: number;
  readonly modified_at: number | null;
}

interface WireCacheStats {
  readonly size_bytes: number;
  readonly file_count: number;
}

/** Combined surface, so the app wires one object rather than three that share a transport. */
export interface MediaClient extends MediaProber, DerivedArtifactService {
  scan(subtree?: AssetPath): Promise<Result<readonly FileEntry[], TransportError>>;
  fileUrl(asset: AssetPath | string): string;
  health(): Promise<Result<SidecarHealth, TransportError>>;
}

export interface SidecarHealth {
  readonly version: string;
  readonly projectRoot: string;
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export function createMediaClient(transport: SidecarTransport): MediaClient {
  /**
   * Reflects the sidecar's own path-then-existence ordering, so an error kind means the same thing
   * on both sides of the wire.
   */
  function toProbeError(asset: AssetPath, error: TransportError): ProbeError {
    if (error.kind === 'rejected') {
      if (error.body.kind === 'not-found') return { kind: 'not-found', asset };
      if (error.body.kind === 'unsupported') {
        return { kind: 'unsupported', asset, detail: error.body.detail };
      }
      if (error.body.kind === 'invalid-path') {
        return { kind: 'unsupported', asset, detail: error.body.detail };
      }
      return { kind: 'corrupt', asset, detail: error.body.detail };
    }
    return { kind: 'sidecar-unavailable', detail: describeTransport(error) };
  }

  function toDerivationError(asset: AssetPath, error: TransportError): DerivationError {
    if (error.kind === 'aborted') return { kind: 'cancelled' };
    if (error.kind === 'rejected') {
      if (error.body.kind === 'not-found') return { kind: 'source-missing', asset };
      return { kind: 'failed', asset, detail: error.body.detail };
    }
    return { kind: 'sidecar-unavailable', detail: describeTransport(error) };
  }

  return {
    async probe(asset: AssetPath): Promise<Result<MediaMetadata, ProbeError>> {
      const response = await transport.postJson<WireMetadata>(
        '/media/probe',
        { asset },
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (!response.ok) return err(toProbeError(asset, response.error));

      try {
        return ok(toMetadata(asset, response.value));
      } catch (error) {
        // A rate string that will not parse, or a negative frame count. The sidecar is trusted but
        // not infallible, and a malformed value must not reach the timeline as NaN.
        return err({
          kind: 'corrupt',
          asset,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async ensure(
      asset: AssetPath,
      spec: DerivedSpec,
      options: DerivationOptions = {},
    ): Promise<Result<DerivedArtifact, DerivationError>> {
      const response = await transport.postJson<WireArtifact>(
        '/media/derive',
        { asset, spec: toWireSpec(spec) },
        {
          timeoutMs: DERIVE_TIMEOUT_MS,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
      if (!response.ok) return err(toDerivationError(asset, response.error));
      return ok({ spec, key: response.value.key, path: response.value.path });
    },

    async peek(asset: AssetPath, spec: DerivedSpec): Promise<DerivedArtifact | undefined> {
      // Deliberately implemented as a probe for the hash plus a key computation, rather than a
      // dedicated endpoint. The hash is memoized in the sidecar, so this is cheap after the first
      // call, and it keeps the cache-key rule in one place instead of two.
      const probed = await this.probe(asset);
      if (!probed.ok) return undefined;
      const key = cacheKey(probed.value.hash, spec);
      return { spec, key, path: `cache/${key}.${extensionFor(spec)}` };
    },

    async readWaveform(
      asset: AssetPath,
      spec: WaveformSpec,
    ): Promise<Result<WaveformPeaks, DerivationError>> {
      const artifact = await this.ensure(asset, spec);
      if (!artifact.ok) return artifact;

      const binary = await transport.getBinary(
        `/media/file?asset=${encodeURIComponent(artifact.value.path)}`,
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (!binary.ok) return err(toDerivationError(asset, binary.error));

      const decoded = decodePeaks(binary.value);
      if (!decoded.ok) {
        return err({ kind: 'failed', asset, detail: describePeaksError(decoded.error) });
      }
      return ok(decoded.value);
    },

    async cacheSize(): Promise<number> {
      const response = await transport.getJson<WireCacheStats>('/cache/stats');
      // Zero on failure rather than throwing: this feeds a size readout in the browser, and a
      // missing number must not break rendering the tree.
      return response.ok ? response.value.size_bytes : 0;
    },

    async clearCache(): Promise<Result<void, DerivationError>> {
      const response = await transport.postJson<WireCacheStats>('/cache/clear', {});
      if (!response.ok) {
        return err({ kind: 'sidecar-unavailable', detail: describeTransport(response.error) });
      }
      return ok(undefined);
    },

    async scan(subtree?: AssetPath): Promise<Result<readonly FileEntry[], TransportError>> {
      const response = await transport.postJson<{ entries: readonly WireScanEntry[] }>('/project/scan', {
        subtree: subtree ?? null,
      });
      if (!response.ok) return response;
      return ok(response.value.entries.map(toFileEntry));
    },

    fileUrl(asset: AssetPath | string): string {
      return transport.fileUrl(asset);
    },

    async health(): Promise<Result<SidecarHealth, TransportError>> {
      const response = await transport.getJson<{
        version: string;
        project_root: string;
        ffmpeg: string;
        ffprobe: string;
      }>('/health', { timeoutMs: 5_000 });
      if (!response.ok) return response;
      return ok({
        version: response.value.version,
        projectRoot: response.value.project_root,
        ffmpeg: response.value.ffmpeg,
        ffprobe: response.value.ffprobe,
      });
    },
  };
}

function toMetadata(asset: AssetPath, wire: WireMetadata): MediaMetadata {
  const hash: ContentHash = contentHash(wire.hash);

  return {
    asset,
    type: wire.type,
    hash,
    sizeBytes: wire.size_bytes,
    ...(wire.duration_seconds !== null ? { durationSeconds: wire.duration_seconds } : {}),
    ...(wire.video !== null
      ? {
          video: {
            width: wire.video.width,
            height: wire.video.height,
            frameRate: parseWireRate(wire.video.frame_rate),
            frames: frameCount(wire.video.frames),
            codec: wire.video.codec,
            rotation: wire.video.rotation,
            ...(wire.video.pixel_aspect !== null ? { pixelAspect: wire.video.pixel_aspect } : {}),
            variableFrameRate: wire.video.variable_frame_rate,
          },
        }
      : {}),
    ...(wire.audio !== null
      ? {
          audio: {
            sampleRate: wire.audio.sample_rate,
            channels: wire.audio.channels,
            codec: wire.audio.codec,
            samples: wire.audio.samples,
          },
        }
      : {}),
    ...(wire.image !== null ? { image: wire.image } : {}),
  };
}

function parseWireRate(raw: string): FrameRate {
  return parseFrameRate(raw);
}

function toFileEntry(wire: WireScanEntry): FileEntry {
  return {
    // Already validated by the sidecar's own containment check; re-branding here would re-run
    // validation on every entry of a large scan for no benefit.
    path: wire.path as AssetPath,
    isDirectory: wire.is_directory,
    sizeBytes: wire.size_bytes,
    ...(wire.modified_at !== null ? { modifiedAt: wire.modified_at * 1000 } : {}),
  };
}

/** Translates a spec to the sidecar's snake_case wire form. */
function toWireSpec(spec: DerivedSpec): Record<string, unknown> {
  switch (spec.kind) {
    case 'proxy':
      return {
        kind: 'proxy',
        short_edge: spec.shortEdge,
        frame_rate: spec.frameRate,
        quality: spec.quality,
      };
    case 'filmstrip':
      return {
        kind: 'filmstrip',
        thumbnail_height: spec.thumbnailHeight,
        thumbnails_per_second: spec.thumbnailsPerSecond,
      };
    case 'waveform':
      return {
        kind: 'waveform',
        buckets_per_second: spec.bucketsPerSecond,
        per_channel: spec.perChannel,
      };
    default: {
      const unreachable: never = spec;
      throw new Error(`Unhandled derived spec ${JSON.stringify(unreachable)}`);
    }
  }
}

function extensionFor(spec: DerivedSpec): string {
  switch (spec.kind) {
    case 'proxy':
      return 'mp4';
    case 'filmstrip':
      return 'jpg';
    case 'waveform':
      return 'peaks';
    default: {
      const unreachable: never = spec;
      throw new Error(`Unhandled derived spec ${JSON.stringify(unreachable)}`);
    }
  }
}

function describeTransport(error: TransportError): string {
  switch (error.kind) {
    case 'unreachable':
      return error.detail;
    case 'aborted':
      return 'cancelled';
    case 'unauthorized':
      return 'the media service rejected our credentials';
    case 'rejected':
      return error.body.detail;
    case 'malformed-response':
      return error.detail;
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled transport error ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Re-exported so callers can convert a probed rate back to a frame position without importing core. */
export { frameIndex };
