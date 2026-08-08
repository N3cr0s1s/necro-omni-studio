import type { AudioBufferProvider, OfflineMixRenderer } from '../contracts/audio-engine.js';
import { type MixPlan, type MixSource, mixAssets, panGains } from '../contracts/mix-plan.js';

/**
 * Rendering the mix for an export.
 *
 * The export delivered a **silent file**. It sent the encoder an audio codec and a bitrate and never an
 * audio stream, so ffmpeg muxed the picture alone — whatever was on the audio tracks. `OfflineMixRenderer`
 * had been declared for exactly this and nothing implemented it, so the path had never run.
 *
 * ## Why the same plan as playback
 *
 * The spec's WYSIWYG guarantee is not only about pixels. A mix that was rendered by different code from
 * the one the user auditioned would differ in precisely the ways nobody checks — a solo that applies in
 * one and not the other, a keyframed fade that ramps linearly here and in steps there. So this consumes
 * `MixPlan`, the same pure description the scheduler consumes, and the only difference between preview
 * and export is which context the nodes are built on.
 *
 * ## Why offline rather than recording playback
 *
 * `OfflineAudioContext` renders as fast as the machine allows and is deterministic: the same document
 * yields the same samples every time. Capturing a live playback would take as long as the sequence, and
 * would fold in whatever the device did to it.
 */

export interface OfflineMixOptions {
  /** Decoded sources. The same provider the preview uses, so nothing is decoded twice. */
  readonly buffers: AudioBufferProvider;
  /**
   * Builds the context. Injected so this is testable without a browser and so a caller can substitute
   * an implementation on a platform where the constructor is named differently.
   */
  readonly createContext: (channels: number, frames: number, sampleRate: number) => OfflineContextLike;
}

/** The part of `OfflineAudioContext` this needs, so a test can supply a stub. */
export interface OfflineContextLike {
  readonly destination: AudioNode;
  readonly sampleRate: number;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  createStereoPanner(): StereoPannerNode;
  startRendering(): Promise<AudioBuffer>;
}

export function createOfflineMixRenderer(options: OfflineMixOptions): OfflineMixRenderer {
  return {
    async render(plans, sampleRate, channels): Promise<AudioBuffer> {
      const endSeconds = plans.reduce((latest, plan) => Math.max(latest, plan.endSeconds), 0);
      const startSeconds = plans.reduce(
        (earliest, plan) => Math.min(earliest, plan.startSeconds),
        plans[0]?.startSeconds ?? 0,
      );

      // At least one frame: `OfflineAudioContext` rejects a length of zero, and an export of a range
      // with no audio in it is a legitimate thing to ask for — it should produce silence, not an error.
      const frames = Math.max(1, Math.ceil((endSeconds - startSeconds) * sampleRate));
      const context = options.createContext(channels, frames, sampleRate);

      // Decoded up front rather than per source: several clips commonly share one file, and the
      // provider caches, so this is one pass to make sure every asset is resident before scheduling.
      await Promise.all(
        [...new Set(plans.flatMap((plan) => mixAssets(plan)))].map((asset) => options.buffers.load(asset)),
      );

      for (const plan of plans) {
        for (const source of plan.sources) {
          schedule(context, source, startSeconds, options.buffers);
        }
      }

      return context.startRendering();
    },
  };
}

/**
 * Schedules one source onto the offline context.
 *
 * A source whose buffer is missing is **skipped**, not fatal. One unreadable file out of forty should
 * cost that clip, and an export that refuses outright leaves the user with nothing at all — the same
 * rule the compositor follows for a frame that has not decoded.
 */
function schedule(
  context: OfflineContextLike,
  source: MixSource,
  originSeconds: number,
  buffers: AudioBufferProvider,
): void {
  const buffer = buffers.peek(source.asset);
  if (buffer === undefined) return;

  const node = context.createBufferSource();
  node.buffer = buffer;
  node.playbackRate.value = source.speed;

  const gain = context.createGain();
  const panner = context.createStereoPanner();
  panner.pan.value = source.pan;

  // Timeline seconds are made relative to the rendered range, which does not necessarily start at zero:
  // exporting frames 300–600 renders a context whose time zero is frame 300.
  const at = Math.max(0, source.startSeconds - originSeconds);

  if (source.gainAutomation.length === 0) {
    gain.gain.value = source.gain;
  } else {
    /*
     * Automation is scheduled as ramps rather than sampled into steps, because that is what the
     * scheduler does for playback. A fade rendered as a staircase and auditioned as a ramp is exactly
     * the divergence the shared plan exists to prevent, and it is audible.
     */
    const points = [...source.gainAutomation].sort((left, right) => left.atSeconds - right.atSeconds);
    const first = points[0];
    if (first !== undefined) {
      gain.gain.setValueAtTime(first.gain, Math.max(0, first.atSeconds - originSeconds));
      for (const point of points.slice(1)) {
        gain.gain.linearRampToValueAtTime(point.gain, Math.max(0, point.atSeconds - originSeconds));
      }
    }
  }

  node.connect(gain);
  gain.connect(panner);
  panner.connect(context.destination);

  // `offsetSeconds` into the file, for `durationSeconds` of timeline. The duration is divided by the
  // rate because `start` measures it in *source* time, so a clip at double speed reads twice as much
  // material — getting this wrong truncates every retimed clip to half its length.
  node.start(at, source.offsetSeconds, source.durationSeconds * Math.max(source.speed, 0.01));
}

/**
 * Stereo gains for a source, exposed for a caller that mixes without a panner node.
 *
 * Kept beside the scheduler so the constant-power law has one definition; a second implementation would
 * drift and the drift would be a level change nobody could account for.
 */
export function sourceChannelGains(source: MixSource): { readonly left: number; readonly right: number } {
  const pan = panGains(source.pan);
  return { left: pan.left * source.gain, right: pan.right * source.gain };
}

/** Whether a set of plans would produce anything audible at all, so a caller can skip the render. */
export function hasAnySource(plans: readonly MixPlan[]): boolean {
  return plans.some((plan) => plan.sources.length > 0);
}
