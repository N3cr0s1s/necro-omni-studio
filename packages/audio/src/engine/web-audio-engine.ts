import {
  type FrameIndex,
  type FrameRate,
  type TimelineDocument,
  frameIndex,
  framesToSecondsNumber,
  secondsNumberToFrames,
  spanFromBounds,
} from '@nos/core';
import {
  type AudioBufferProvider,
  type AudioEngine,
  type MeterReading,
  type MixSource,
  type PlaybackStatus,
  type SchedulerOptions,
  DEFAULT_SCHEDULER,
  SCRUB_GRAIN_SECONDS,
  createPeakMeter,
} from '../contracts/index.js';
import { buildMixPlan } from '../plan/build-mix-plan.js';

/**
 * Web Audio playback.
 *
 * ## The scheduling model
 *
 * Web Audio is scheduled ahead of a hardware clock, not driven per frame. The engine keeps a horizon
 * `lookaheadSeconds` in front of `context.currentTime` and, on each tick, schedules every source starting
 * before that horizon. Sources already scheduled are remembered so a tick never double-schedules — that
 * would play the same clip twice, phase-summed, which is instantly audible and easy to write by accident.
 *
 * ## Why the audio clock drives the transport
 *
 * `context.currentTime` is the only steady clock available. Driving the playhead from it and the picture
 * from the playhead keeps them locked; driving audio from `requestAnimationFrame` instead would drift
 * against the device and need continuous correction.
 */

export interface WebAudioEngineOptions {
  readonly context: BaseAudioContext & { readonly destination: AudioDestinationNode };
  readonly buffers: AudioBufferProvider;
  /** Read on every tick, so an edit is heard within one lookahead window. */
  readonly getDocument: () => TimelineDocument;
  readonly scheduler?: SchedulerOptions;
  /** Injected so tests can drive scheduling deterministically instead of waiting on a timer. */
  readonly setInterval?: (handler: () => void, ms: number) => () => void;
  readonly now?: () => number;
}

/** A source scheduled into the graph, tracked so it can be stopped and not re-scheduled. */
interface ScheduledSource {
  readonly key: string;
  readonly node: AudioBufferSourceNode;
  readonly endsAt: number;
}

export function createWebAudioEngine(options: WebAudioEngineOptions): AudioEngine {
  const { context, buffers, getDocument } = options;
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const now = options.now ?? (() => Date.now());
  const startTimer =
    options.setInterval ??
    ((handler: () => void, ms: number) => {
      const id = setInterval(handler, ms);
      return () => clearInterval(id);
    });

  const master = context.createGain();
  const analyser = context.createAnalyser();
  // A modest FFT size: the meter needs peak amplitude, not spectral resolution, and a smaller buffer
  // means the reading tracks transients more closely.
  analyser.fftSize = 1024;
  master.connect(analyser);
  analyser.connect(context.destination);

  const meter = createPeakMeter(2, now);
  const meterBuffer = new Float32Array(analyser.fftSize);

  let state: PlaybackStatus = { state: 'stopped', frame: frameIndex(0), starved: false };
  const listeners = new Set<(status: PlaybackStatus) => void>();

  /** Context time corresponding to timeline frame 0 for the current playback run. */
  let timelineOrigin = 0;
  /** Frames already planned, so the next tick continues rather than replanning. */
  let plannedThroughFrame = frameIndex(0);
  const scheduled = new Map<string, ScheduledSource>();
  let cancelTimer: (() => void) | undefined;
  let scrubNode: AudioBufferSourceNode | undefined;

  function publish(next: Partial<PlaybackStatus>): void {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener(state);
  }

  function frameRate(): FrameRate {
    return getDocument().frameRate;
  }

  /** Current transport position, derived from the audio clock. */
  function currentFrame(): FrameIndex {
    if (state.state !== 'playing') return state.frame;
    const elapsed = context.currentTime - timelineOrigin;
    return secondsNumberToFrames(Math.max(0, elapsed), frameRate());
  }

  /**
   * Builds the graph for one source.
   *
   * Gain and pan are separate nodes rather than folded together because gain is automated over time while
   * pan is constant for the block; keeping them apart means an automation ramp does not have to be
   * recomputed against the pan law on every point.
   */
  function scheduleSource(source: MixSource, buffer: AudioBuffer): void {
    const key = `${source.clip}@${source.startSeconds.toFixed(6)}`;
    if (scheduled.has(key)) return;

    const node = context.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = source.speed;

    const gain = context.createGain();
    const panner = context.createStereoPanner();

    const startAt = timelineOrigin + source.startSeconds;
    // Never schedule in the past: a start time behind `currentTime` plays immediately at full level,
    // which on a late decode manifests as a stutter rather than a dropped sample.
    const safeStart = Math.max(startAt, context.currentTime + scheduler.scheduleMarginSeconds);
    const trimmedOffset = source.offsetSeconds + Math.max(0, safeStart - startAt) * source.speed;
    const remaining = source.durationSeconds - Math.max(0, safeStart - startAt);
    if (remaining <= 0) return;

    if (source.gainAutomation.length === 0) {
      gain.gain.value = source.gain;
    } else {
      // Ramps are anchored with setValueAtTime first, or the first ramp would interpolate from whatever
      // the parameter happened to hold.
      const first = source.gainAutomation[0]!;
      gain.gain.setValueAtTime(first.gain, timelineOrigin + first.atSeconds);
      for (const point of source.gainAutomation.slice(1)) {
        gain.gain.linearRampToValueAtTime(point.gain, timelineOrigin + point.atSeconds);
      }
    }

    // StereoPannerNode implements equal-power panning itself, so the pan value passes straight through.
    // `panGains` remains the authority for the offline renderer, which has no panner node.
    panner.pan.value = source.pan;

    node.connect(gain);
    gain.connect(panner);
    panner.connect(master);

    node.start(safeStart, Math.max(0, trimmedOffset), remaining);

    const record: ScheduledSource = { key, node, endsAt: safeStart + remaining };
    scheduled.set(key, record);
    node.onended = () => {
      scheduled.delete(key);
      node.disconnect();
      gain.disconnect();
      panner.disconnect();
    };
  }

  /**
   * Schedules everything starting before the lookahead horizon.
   *
   * A source whose buffer is not resident is left unscheduled and the engine reports `starved` — the tick
   * requests a decode and a later tick picks it up. Blocking here would stall the whole graph for one
   * missing file.
   */
  function tick(): void {
    if (state.state !== 'playing') return;

    const document = getDocument();
    const rate = document.frameRate;
    const horizonSeconds = context.currentTime - timelineOrigin + scheduler.lookaheadSeconds;
    const horizonFrame = secondsNumberToFrames(Math.max(0, horizonSeconds), rate);

    if (horizonFrame > plannedThroughFrame) {
      const span = spanFromBounds(plannedThroughFrame, horizonFrame);
      const plan = buildMixPlan({ document, span });

      let starved = false;
      buffers.prefetch(plan.sources.map((source) => source.asset));

      for (const source of plan.sources) {
        const buffer = buffers.peek(source.asset);
        if (buffer === undefined) {
          starved = true;
          // Kick off the decode; a later tick will schedule it once resident.
          void buffers.load(source.asset);
          continue;
        }
        scheduleSource(source, buffer);
      }

      plannedThroughFrame = horizonFrame;
      publish({ frame: currentFrame(), starved });
      return;
    }

    publish({ frame: currentFrame() });
  }

  function stopAllScheduled(): void {
    for (const record of scheduled.values()) {
      try {
        record.node.stop();
      } catch {
        // Stopping a node that already ended throws in some implementations. Harmless here: the goal is
        // silence, and an already-finished node is silent.
      }
      record.node.disconnect();
    }
    scheduled.clear();
  }

  return {
    getStatus: () => ({ ...state, frame: currentFrame() }),

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async play(from: FrameIndex): Promise<void> {
      if (state.state === 'playing' && state.frame === from) return;

      this.stop();

      // A context created before a user gesture starts suspended; resuming is required or nothing sounds
      // and no error is raised.
      if ('resume' in context && context.state === 'suspended') {
        await (context as AudioContext).resume();
      }

      const document = getDocument();
      // The origin is offset back by the start frame so `timelineOrigin + startSeconds` lands correctly
      // for a source anywhere on the timeline, not only from zero.
      timelineOrigin =
        context.currentTime +
        scheduler.scheduleMarginSeconds -
        framesToSecondsNumber(from, document.frameRate);
      plannedThroughFrame = from;

      publish({ state: 'playing', frame: from, starved: false });
      tick();
      cancelTimer = startTimer(tick, scheduler.tickIntervalMs);
    },

    stop(): void {
      cancelTimer?.();
      cancelTimer = undefined;
      stopAllScheduled();
      publish({ state: 'stopped', frame: currentFrame(), starved: false });
    },

    seek(frame: FrameIndex): void {
      const wasPlaying = state.state === 'playing';
      this.stop();
      publish({ frame });
      if (wasPlaying) void this.play(frame);
    },

    /**
     * Plays a short grain at a frame.
     *
     * Each grain replaces the previous one, so dragging fast produces a sequence of short sounds rather
     * than a pile of overlapping ones. Anything already playing is stopped first — hearing scrub audio on
     * top of playback would be incoherent.
     */
    scrub(frame: FrameIndex): void {
      if (state.state === 'playing') this.stop();

      scrubNode?.stop();
      scrubNode?.disconnect();
      scrubNode = undefined;

      const document = getDocument();
      const rate = document.frameRate;
      const grainFrames = Math.max(1, secondsNumberToFrames(SCRUB_GRAIN_SECONDS, rate));
      const plan = buildMixPlan({
        document,
        span: spanFromBounds(frame, frameIndex(frame + grainFrames)),
      });

      publish({ state: 'scrubbing', frame });

      // Only the loudest source is auditioned. Summing every layer while dragging produces mush; the
      // dominant one is what the user is listening for.
      const loudest = [...plan.sources].sort((a, b) => b.gain - a.gain)[0];
      if (loudest === undefined) return;

      const buffer = buffers.peek(loudest.asset);
      if (buffer === undefined) {
        void buffers.load(loudest.asset);
        return;
      }

      const node = context.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = loudest.speed;

      const gain = context.createGain();
      // A short fade at both ends: starting a grain mid-waveform clicks, and a click per pointer move is
      // far more objectionable than the scrub audio itself.
      const fade = Math.min(0.005, SCRUB_GRAIN_SECONDS / 4);
      const startAt = context.currentTime + 0.001;
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(loudest.gain, startAt + fade);
      gain.gain.setValueAtTime(loudest.gain, startAt + SCRUB_GRAIN_SECONDS - fade);
      gain.gain.linearRampToValueAtTime(0, startAt + SCRUB_GRAIN_SECONDS);

      node.connect(gain);
      gain.connect(master);
      node.start(startAt, Math.max(0, loudest.offsetSeconds), SCRUB_GRAIN_SECONDS);
      node.onended = () => {
        node.disconnect();
        gain.disconnect();
      };
      scrubNode = node;
    },

    readMeters(): MeterReading {
      analyser.getFloatTimeDomainData(meterBuffer);
      // The analyser sums to mono, so both channels report the same peak. Per-channel metering needs a
      // splitter and two analysers; deferred until the mixer UI actually shows separate channels.
      meter.push([meterBuffer, meterBuffer]);
      return meter.read();
    },

    setMasterGain(gain: number): void {
      master.gain.value = Math.max(0, gain);
    },

    dispose(): void {
      cancelTimer?.();
      stopAllScheduled();
      scrubNode?.disconnect();
      master.disconnect();
      analyser.disconnect();
      listeners.clear();
    },
  };
}
