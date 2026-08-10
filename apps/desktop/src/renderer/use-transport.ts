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
  /**
   * Where playback returns to when it reaches the end, or absent to stop there.
   *
   * The mockups put a `loop` beside the in and out points, and the reason is the ordinary way a cut
   * gets judged: you watch the same four seconds twenty times. Stopping at the out point meant
   * pressing play again for each of them, and the playhead had to be dragged back first — two
   * gestures between every viewing of the thing being decided.
   *
   * A frame rather than a flag, so the caller decides what "the loop" means. It is the in point when
   * a range is marked and the start of the sequence otherwise, and that choice belongs to the shell:
   * this hook does not know that a work range exists.
   */
  readonly loopFrom?: FrameIndex | undefined;
  readonly initialFrame?: FrameIndex;
  /**
   * Audio playback, when there is any.
   *
   * The engine's contract makes the audio clock authoritative during playback — `context.currentTime` is
   * the only steady clock available, and driving picture from it is what keeps the two locked. So when
   * the engine reports a frame, that frame wins over this hook's own wall clock. A video-only timeline
   * has no audio clock to follow and keeps the wall clock, which is why the fallback exists rather than
   * simply deferring to the engine always.
   */
  readonly audio?: {
    readonly available: boolean;
    readonly frame: FrameIndex | undefined;
    play(from: FrameIndex): void;
    stop(): void;
    seek(frame: FrameIndex): void;
  };
}

export function useTransport(options: TransportOptions): Transport {
  const { frameRate, endFrame, loopFrom, audio } = options;
  const [frame, setFrame] = useState<FrameIndex>(options.initialFrame ?? frameIndex(0));
  const [playing, setPlaying] = useState(false);

  // The wall-clock anchor for the current run: the moment playback started and the frame it started
  // from. Both reset on every seek, or a seek mid-playback would be undone on the next tick.
  const anchor = useRef({ startedAtMs: 0, startFrame: 0 });
  const latest = useRef({ endFrame, frameRate, loopFrom, audio });
  latest.current = { endFrame, frameRate, loopFrom, audio };

  const seek = useCallback((next: FrameIndex) => {
    const clamped = frameIndex(Math.max(0, Math.min(latest.current.endFrame, next)));
    anchor.current = { startedAtMs: performance.now(), startFrame: clamped };
    latest.current.audio?.seek(clamped);
    setFrame(clamped);
  }, []);

  const play = useCallback(() => {
    setPlaying((current) => {
      if (current) return current;
      setFrame((at) => {
        // Restart when parked at the end, which is what a play button is expected to do rather than
        // sitting there doing nothing. Back to the loop point when there is one: with a range marked,
        // "play again" means the range, not the top of the sequence.
        const restart = latest.current.loopFrom ?? frameIndex(0);
        const from = at >= latest.current.endFrame ? restart : at;
        anchor.current = { startedAtMs: performance.now(), startFrame: from };
        latest.current.audio?.play(from);
        return from;
      });
      return true;
    });
  }, []);

  const pause = useCallback(() => {
    latest.current.audio?.stop();
    setPlaying(false);
  }, []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  const step = useCallback((delta: number) => {
    latest.current.audio?.stop();
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
      const fromAudio = latest.current.audio?.available === true ? latest.current.audio.frame : undefined;

      // The audio clock wins when there is one. Falling back to the wall clock is not a degradation for a
      // video-only timeline — there is simply nothing to lock to.
      const elapsedSeconds = (performance.now() - startedAtMs) / 1000;
      const advanced = Math.floor(elapsedSeconds * frameRateToNumber(latest.current.frameRate));
      const next = fromAudio ?? startFrame + advanced;

      if (next >= latest.current.endFrame) {
        const back = latest.current.loopFrom;
        if (back !== undefined && back < latest.current.endFrame) {
          /*
           * Round the loop rather than stop.
           *
           * The anchor is reset to *now* and the audio re-seeked, exactly as `seek` does — a loop that
           * only moved the frame would leave the wall clock counting from the original start, so the
           * second pass would jump straight back to the end. And the audio engine has to be told, or
           * the picture returns to the in point while the sound plays on past the out.
           */
          anchor.current = { startedAtMs: performance.now(), startFrame: back };
          latest.current.audio?.seek(back);
          setFrame(back);
          raf = requestAnimationFrame(tick);
          return;
        }

        latest.current.audio?.stop();
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
