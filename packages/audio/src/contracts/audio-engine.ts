import type { AssetPath, FrameIndex, Result } from '@nos/core';
import type { MeterReading, MixPlan } from './mix-plan.js';

/**
 * Playback contracts.
 *
 * Web Audio is behind an interface for two reasons beyond testability. Export needs the same mix rendered
 * offline into a buffer rather than to a device, which is a different context type with the same graph;
 * and the spec's scrubbing requirement behaves unlike playback, so having the seam lets both be
 * implemented without either compromising the other.
 */

export type PlaybackState = 'stopped' | 'playing' | 'scrubbing';

export interface PlaybackStatus {
  readonly state: PlaybackState;
  /** Where the transport is, in project frames. */
  readonly frame: FrameIndex;
  /** True when the engine is waiting on a decode and cannot advance. */
  readonly starved: boolean;
}

export type AudioLoadError =
  | { readonly kind: 'not-found'; readonly asset: AssetPath }
  | { readonly kind: 'decode-failed'; readonly asset: AssetPath; readonly detail: string }
  | { readonly kind: 'cancelled' };

/**
 * Supplies decoded audio.
 *
 * Decoded buffers are large — a stereo minute at 48 kHz is ~23 MB as float — so the provider owns the
 * caching and eviction policy. The engine only asks; it must not decide what stays in memory, because
 * export and preview have opposite needs (export streams once, preview revisits the same few seconds).
 */
export interface AudioBufferProvider {
  /** Decoded buffer if already resident, without starting work. Drives gapless scheduling. */
  peek(asset: AssetPath): AudioBuffer | undefined;
  /** Decodes if needed. */
  load(asset: AssetPath): Promise<Result<AudioBuffer, AudioLoadError>>;
  /** Hints that these assets will be needed shortly. */
  prefetch(assets: readonly AssetPath[]): void;
}

/**
 * Drives audio playback.
 *
 * `frame` is the authority on transport position during playback: the audio clock is the only steady one
 * available, and driving video from it rather than the reverse is what keeps picture and sound locked. A
 * `requestAnimationFrame` clock drifts against the audio device and would need continuous correction.
 */
export interface AudioEngine {
  getStatus(): PlaybackStatus;
  subscribe(listener: (status: PlaybackStatus) => void): () => void;

  /** Begins playback at a frame. Idempotent while already playing from the same position. */
  play(from: FrameIndex): Promise<void>;
  stop(): void;
  /** Moves the transport without playing. */
  seek(frame: FrameIndex): void;

  /**
   * Plays a short grain at a frame, for scrubbing.
   *
   * Distinct from `play` because dragging the playhead needs the sound *at* a position rather than
   * continuous playback from it: a grain per pointer move, each replacing the last.
   */
  scrub(frame: FrameIndex): void;

  /** Current meter reading, for the transport bar. */
  readMeters(): MeterReading;
  /**
   * Clears the latched clip indicator.
   *
   * On the engine rather than on whatever is displaying the meter: the latch lives with the meter
   * that set it, and a UI that cleared its own copy would have the clip re-reported on the next poll.
   */
  resetMeters(): void;

  /** Master output gain, linear. */
  setMasterGain(gain: number): void;

  dispose(): void;
}

/**
 * Renders a mix offline.
 *
 * Separate from `AudioEngine` on purpose: export has no transport, no meters and no scrubbing, and
 * conflating them would put playback state into the export path.
 */
export interface OfflineMixRenderer {
  render(plans: readonly MixPlan[], sampleRate: number, channels: number): Promise<AudioBuffer>;
}

/**
 * Scheduling parameters.
 *
 * The lookahead is the core trade-off in Web Audio scheduling: too short and a slow tick produces a
 * dropout, too long and an edit takes that long to be heard. 200 ms of lookahead with a 50 ms tick is the
 * conventional compromise — it survives a missed tick or two while keeping edit latency below the
 * threshold where it feels laggy.
 */
export interface SchedulerOptions {
  readonly lookaheadSeconds: number;
  readonly tickIntervalMs: number;
  /** Extra time before a scheduled source, so a decode landing late does not clip its attack. */
  readonly scheduleMarginSeconds: number;
}

export const DEFAULT_SCHEDULER: SchedulerOptions = {
  lookaheadSeconds: 0.2,
  tickIntervalMs: 50,
  scheduleMarginSeconds: 0.02,
};

/**
 * Scrub grain length.
 *
 * Long enough to convey pitch and content, short enough that consecutive grains during a drag do not pile
 * up into a smear. Roughly two frames at 30 fps.
 */
export const SCRUB_GRAIN_SECONDS = 0.08;
