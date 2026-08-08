import { useCallback, useEffect, useRef, useState } from 'react';
import { type FrameIndex, type FrameRate, frameIndex, frameRateToNumber } from '@nos/core';

/**
 * The transport.
 *
 * Playback advances the playhead from a wall clock rather than by counting frames, which is the whole
 * design decision here: a `+1` per animation frame drifts as soon as a render takes longer than a frame
 * — slowly on a fast machine, obviously on a slow one — and the drift is silent. Deriving the frame from
 * elapsed time means a dropped frame is *dropped*, not accumulated as a timing error, so audio and video
 * stay aligned however badly the renderer is doing.
 *
 * The playhead stays an integer frame index. Everything downstream — the render plan, the mix plan, the
 * timecode readout — is defined in frames, and a fractional playhead would have to be rounded by each of
 * them independently, at which point they can disagree.
 */

export interface Transport {
  readonly playing: boolean;
  readonly frame: FrameIndex;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(frame: FrameIndex): void;
  step(delta: number): void;
}

export interface TransportOptions {
  readonly frameRate: FrameRate;
  /** One past the last frame. Playback stops here rather than running into empty timeline. */
  readonly endFrame: number;
  readonly initialFrame?: FrameIndex;
}

export function useTransport(options: TransportOptions): Transport {
  const { frameRate, endFrame } = options;
  const [frame, setFrame] = useState<FrameIndex>(options.initialFrame ?? frameIndex(0));
  const [playing, setPlaying] = useState(false);

  // The wall-clock anchor for the current run: the moment playback started and the frame it started
  // from. Both reset on every seek, or a seek mid-playback would be undone on the next tick.
  const anchor = useRef({ startedAtMs: 0, startFrame: 0 });
  const latest = useRef({ endFrame, frameRate });
  latest.current = { endFrame, frameRate };

  const seek = useCallback((next: FrameIndex) => {
    const clamped = frameIndex(Math.max(0, Math.min(latest.current.endFrame, next)));
    anchor.current = { startedAtMs: performance.now(), startFrame: clamped };
    setFrame(clamped);
  }, []);

  const play = useCallback(() => {
    setPlaying((current) => {
      if (current) return current;
      setFrame((at) => {
        // Restart from the beginning when parked at the end, which is what a play button is expected to
        // do rather than sitting there doing nothing.
        const from = at >= latest.current.endFrame ? frameIndex(0) : at;
        anchor.current = { startedAtMs: performance.now(), startFrame: from };
        return from;
      });
      return true;
    });
  }, []);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  const step = useCallback((delta: number) => {
    setPlaying(false);
    setFrame((at) => {
      const next = frameIndex(Math.max(0, Math.min(latest.current.endFrame, at + delta)));
      anchor.current = { startedAtMs: performance.now(), startFrame: next };
      return next;
    });
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;

    const tick = (): void => {
      const { startedAtMs, startFrame } = anchor.current;
      const elapsedSeconds = (performance.now() - startedAtMs) / 1000;
      const advanced = Math.floor(elapsedSeconds * frameRateToNumber(latest.current.frameRate));
      const next = startFrame + advanced;

      if (next >= latest.current.endFrame) {
        setFrame(frameIndex(latest.current.endFrame));
        setPlaying(false);
        return;
      }

      setFrame(frameIndex(next));
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  return { playing, frame, play, pause, toggle, seek, step };
}

/**
 * Keyboard transport.
 *
 * Space, and the arrow keys for single frames. Attached to the window rather than to a focused element
 * because a video editor's transport has to work wherever the pointer happens to be — but suppressed
 * while a text field has focus, or typing a prompt would scrub the timeline.
 */
export function useTransportKeys(transport: Transport): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      switch (event.key) {
        case ' ':
          transport.toggle();
          break;
        case 'ArrowLeft':
          transport.step(event.shiftKey ? -10 : -1);
          break;
        case 'ArrowRight':
          transport.step(event.shiftKey ? 10 : 1);
          break;
        case 'Home':
          transport.seek(frameIndex(0));
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [transport]);
}
