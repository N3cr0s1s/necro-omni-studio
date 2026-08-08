import {
  type FrameRate,
  type FrameSpan,
  type Resolution,
  type Result,
  type ValidationIssue,
  displayFrameRate,
  err,
  ok,
} from '@nos/core';

/**
 * Export settings.
 *
 * The spec fixes the scope: H.264/H.265 in an mp4 container, rendered by the same WebGL2 compositor that
 * drives the preview. No colour management, no alternate containers — those are explicit non-goals, and
 * offering them here would imply a pipeline that does not exist.
 */

export const VIDEO_CODECS = ['h264', 'h265'] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

export const AUDIO_CODECS = ['aac', 'flac'] as const;
export type AudioCodec = (typeof AUDIO_CODECS)[number];

/**
 * Quality, expressed the way an editor thinks about it.
 *
 * A named ladder rather than a raw CRF number: "visually lossless / high / medium" is a decision a user
 * can make, where "CRF 18" requires knowing what CRF is. The mapping lives in one place so a future
 * codec addition cannot drift from it.
 */
export const QUALITY_PRESETS = ['maximum', 'high', 'balanced', 'small'] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];

/**
 * CRF per quality and codec.
 *
 * H.265 needs a higher CRF for the same perceived quality — its scale is roughly six points offset from
 * H.264's, which is why this is a table rather than one number reused for both.
 */
const CRF_TABLE: Readonly<Record<VideoCodec, Readonly<Record<QualityPreset, number>>>> = {
  h264: { maximum: 16, high: 19, balanced: 23, small: 28 },
  h265: { maximum: 20, high: 24, balanced: 28, small: 33 },
};

export function crfFor(codec: VideoCodec, quality: QualityPreset): number {
  return CRF_TABLE[codec][quality];
}

/**
 * Encoder speed.
 *
 * Slower presets buy a real bitrate saving at the same quality, but an editor waiting on a deliverable
 * usually values time more. `medium` is the default for that reason, with the trade exposed rather than
 * decided silently.
 */
export const ENCODER_SPEEDS = ['veryfast', 'fast', 'medium', 'slow'] as const;
export type EncoderSpeed = (typeof ENCODER_SPEEDS)[number];

export interface ExportSettings {
  /** Destination, project-relative. Conventionally under `renders/`. */
  readonly outputPath: string;
  readonly range: FrameSpan;
  readonly resolution: Resolution;
  readonly frameRate: FrameRate;
  readonly videoCodec: VideoCodec;
  readonly quality: QualityPreset;
  readonly speed: EncoderSpeed;
  readonly audioCodec: AudioCodec;
  readonly audioBitrateKbps: number;
  /**
   * Whether to render at proxy resolution.
   *
   * Offered because a review copy is a legitimate deliverable and rendering one at full resolution wastes
   * minutes. It is never the default: an export that quietly delivered a proxy would be a serious
   * failure.
   */
  readonly useProxyResolution: boolean;
}

export const DEFAULT_EXPORT: Omit<ExportSettings, 'outputPath' | 'range' | 'resolution' | 'frameRate'> =
  {
    videoCodec: 'h264',
    quality: 'high',
    speed: 'medium',
    audioCodec: 'aac',
    audioBitrateKbps: 320,
    useProxyResolution: false,
  };

/**
 * Validates settings before an export starts.
 *
 * Every problem is reported at once, with the field named. An export is a long operation, and failing on
 * the second problem after the user fixed the first is a poor trade for a few lines of code.
 */
export function validateExportSettings(
  settings: ExportSettings,
): Result<ExportSettings, readonly ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  if (settings.outputPath.trim() === '') {
    issues.push({ path: 'outputPath', message: 'choose where to save the export' });
  } else if (!settings.outputPath.toLowerCase().endsWith('.mp4')) {
    // The container is fixed by the spec, and a mismatched extension would produce a file the OS opens
    // with the wrong application.
    issues.push({ path: 'outputPath', message: 'the output must be an .mp4 file' });
  }

  if (settings.range.duration <= 0) {
    issues.push({ path: 'range', message: 'the export range is empty' });
  }

  if (settings.resolution.width <= 0 || settings.resolution.height <= 0) {
    issues.push({ path: 'resolution', message: 'the resolution must be positive' });
  } else if (settings.resolution.width % 2 !== 0 || settings.resolution.height % 2 !== 0) {
    // H.264 and H.265 with 4:2:0 chroma require even dimensions. ffmpeg would fail late with an opaque
    // message, so it is caught here where the field can be named.
    issues.push({
      path: 'resolution',
      message: 'width and height must both be even for H.264/H.265',
    });
  }

  if (settings.audioBitrateKbps <= 0) {
    issues.push({ path: 'audioBitrateKbps', message: 'the audio bitrate must be positive' });
  }

  return issues.length > 0 ? err(issues) : ok(settings);
}

/** Estimated output size in bytes, for the dialog's "about 240 MB" line. */
export function estimateSizeBytes(settings: ExportSettings, durationSeconds: number): number {
  // Rough bits-per-pixel-per-frame for each quality tier, derived from typical x264 output. Deliberately
  // approximate: the dialog says "about", and a precise number would be a lie for content-dependent
  // encoding.
  const bitsPerPixel: Record<QualityPreset, number> = {
    maximum: 0.18,
    high: 0.1,
    balanced: 0.06,
    small: 0.03,
  };
  const codecFactor = settings.videoCodec === 'h265' ? 0.65 : 1;
  const pixelsPerSecond =
    settings.resolution.width * settings.resolution.height * frameRateNumber(settings.frameRate);

  const videoBits = pixelsPerSecond * bitsPerPixel[settings.quality] * codecFactor * durationSeconds;
  const audioBits = settings.audioBitrateKbps * 1000 * durationSeconds;
  return Math.round((videoBits + audioBits) / 8);
}

function frameRateNumber(rate: FrameRate): number {
  return rate.value.numerator / rate.value.denominator;
}

/** `1920×1080 · 29.97 · H.264 high` style summary for the dialog. */
export function describeSettings(settings: ExportSettings): string {
  const codec = settings.videoCodec === 'h264' ? 'H.264' : 'H.265';
  return `${settings.resolution.width}×${settings.resolution.height} · ${displayFrameRate(
    settings.frameRate,
  )} · ${codec} ${settings.quality}`;
}

/** Human-readable size, matching the media browser's formatting. */
export function formatEstimate(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(2)} GB`;
}
