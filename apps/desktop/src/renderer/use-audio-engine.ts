import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AssetPath, type FrameIndex, type TimelineDocument } from '@nos/core';
import { type AudioEngine, type MeterReading, createWebAudioEngine, hasAudibleContent } from '@nos/audio';
import { type AudioBufferCache, createAudioBufferCache } from './audio-buffers.js';
import type { SidecarInfo } from '../main/ipc-contract.js';
import { fileUrl } from './file-url.js';

/**
 * Playback audio.
 *
 * Connects the engine that was written and tested in `@nos/audio` to the two things it needs from the
 * shell: an `AudioContext` and decoded buffers from the project folder.
 *
 * The engine's own contract says the **audio clock drives the transport**, because `context.currentTime`
 * is the only steady clock available and driving picture from it keeps the two locked. That is honoured
 * here — but only while audio is actually playing. A project with no audible content has no audio clock
 * to follow, and a video-only timeline must still play, so the transport falls back to its wall clock in
 * that case rather than sitting at frame zero waiting for a tick that never comes.
 */

export interface PlaybackAudio {
  /** False when the browser refused a context, or the project has nothing to hear. */
  readonly available: boolean;
  readonly detail: string;
  /** The engine's transport position while it is playing, otherwise `undefined`. */
  readonly frame: FrameIndex | undefined;
  readonly meters: MeterReading | undefined;
  readonly cacheBytes: number;
  /** Acknowledges a latched clip indicator. */
  clearClip(): void;
  play(from: FrameIndex): void;
  stop(): void;
  seek(frame: FrameIndex): void;
  scrub(frame: FrameIndex): void;
}

/** How long the meter keeps falling after playback stops, so the last peak is still readable. */
const METER_TAIL_MS = 1500;

/** Below this a bar is empty; polling past it animates nothing. */
const METER_FLOOR = 0.0005;

export interface PlaybackAudioOptions {
  readonly document: TimelineDocument;
  readonly sidecar: SidecarInfo | undefined;
}

export function usePlaybackAudio({ document, sidecar }: PlaybackAudioOptions): PlaybackAudio {
  const [engine, setEngine] = useState<AudioEngine | undefined>(undefined);
  const [cache, setCache] = useState<AudioBufferCache | undefined>(undefined);
  const [frame, setFrame] = useState<FrameIndex | undefined>(undefined);
  const [meters, setMeters] = useState<MeterReading | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [detail, setDetail] = useState('audio starts with the first playback');

  // Read by the engine on every tick, so an edit is heard within one lookahead window rather than on the
  // next play. A ref rather than a dependency: rebuilding the engine per edit would restart playback.
  const documentRef = useRef(document);
  documentRef.current = document;

  const urlFor = useCallback(
    (asset: AssetPath): string | undefined => {
      if (sidecar === undefined || !sidecar.available) return undefined;
      // The token travels in the query because a media fetch here shares the endpoint that `<video>`
      // elements use, and that endpoint accepts it only for exactly this reason.
      return fileUrl(sidecar, asset);
    },
    [sidecar],
  );

  /**
   * Creates the context lazily, on the first play.
   *
   * Browsers refuse an `AudioContext` created before a user gesture, and one created eagerly at startup
   * lands in `suspended` with no obvious symptom other than silence.
   */
  const ensure = useCallback((): AudioEngine | undefined => {
    if (engine !== undefined) return engine;

    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch (error) {
      setDetail(`this machine refused an audio context: ${String(error)}`);
      return undefined;
    }

    const buffers = createAudioBufferCache({ context, urlFor });
    const created = createWebAudioEngine({
      context,
      buffers,
      getDocument: () => documentRef.current,
    });

    setCache(buffers);
    setEngine(created);
    setDetail('audio ready');
    return created;
  }, [engine, urlFor]);

  useEffect(() => {
    if (engine === undefined) return;
    return engine.subscribe((status) => {
      // Only while playing: a stopped engine reports the last position it reached, and treating that as
      // authoritative would fight every seek the user makes.
      setFrame(status.state === 'playing' ? status.frame : undefined);
      setPlaying(status.state === 'playing');
    });
  }, [engine]);

  /**
   * Polls the meter.
   *
   * On an animation frame rather than during render, because `readMeters` is not a query: it pushes
   * the analyser's latest block into the peak meter and advances its decay. Reading it while
   * rendering would make the level depend on how often React happened to re-render, and would double
   * every reading under a strict-mode double render.
   *
   * Polling continues briefly after playback stops so the meter *falls* to silence at its own decay
   * rate. Snapping it to zero on stop would hide the last peak, which is exactly the one an editor
   * was watching for.
   */
  useEffect(() => {
    if (engine === undefined) return;
    if (!playing) {
      // A few frames of tail, then nothing: a meter polled forever would keep a timer alive for the
      // life of the window to animate a bar that is already empty.
      let remaining = Math.ceil((METER_TAIL_MS / 1000) * 60);
      let raf = 0;
      const tick = (): void => {
        const reading = engine.readMeters();
        setMeters(reading);
        remaining -= 1;
        if (remaining > 0 && reading.peaks.some((peak) => peak > METER_FLOOR)) {
          raf = requestAnimationFrame(tick);
        } else {
          setMeters(undefined);
        }
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    let raf = 0;
    const tick = (): void => {
      setMeters(engine.readMeters());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, playing]);

  useEffect(() => () => engine?.dispose(), [engine]);

  const audible = useMemo(() => hasAudibleContent(document), [document]);

  return {
    available: engine !== undefined && audible,
    detail: audible ? detail : 'this timeline has no audible clips',
    frame,
    meters,
    cacheBytes: cache?.sizeBytes ?? 0,

    play(from) {
      if (!audible) return;
      void ensure()?.play(from);
    },
    stop() {
      engine?.stop();
      setFrame(undefined);
      setPlaying(false);
    },
    seek(to) {
      engine?.seek(to);
    },
    scrub(at) {
      if (!audible) return;
      ensure()?.scrub(at);
    },
    clearClip() {
      // The engine owns the latch, so clearing goes through it rather than through this hook's copy —
      // otherwise the next poll would immediately re-report the clip the user just acknowledged.
      engine?.resetMeters();
      setMeters(undefined);
    },
  };
}
