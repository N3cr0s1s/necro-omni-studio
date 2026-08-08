import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { clampSeek, scrubbableDuration } from './media-clock.js';

/**
 * Driving a media element, without owning how it looks.
 *
 * Split from the bar it feeds because the two change for different reasons. What a transport *is* —
 * playing or not, how far in, how long — is the same for a sound effect in the browser and for any
 * future audition surface; how it is *drawn* is a shadcn arrangement that will be revised.
 *
 * The element stays the source of truth. Its own state can change without this code asking — playback
 * reaching the end, a codec failing halfway, the user hitting a media key — so every field here is read
 * back from its events rather than predicted from the call that started them. The alternative is a
 * button that says "pause" over a file that stopped a second ago.
 */

export interface MediaTransportState {
  readonly playing: boolean;
  readonly currentSeconds: number;
  /** Absent until metadata arrives, and for anything without a knowable end. */
  readonly durationSeconds: number | undefined;
  readonly muted: boolean;
  /** True once the element has enough to play, so a dead control can be disabled rather than silent. */
  readonly ready: boolean;
}

export interface MediaTransportControls {
  readonly toggle: () => void;
  readonly seek: (seconds: number) => void;
  readonly restart: () => void;
  readonly toggleMuted: () => void;
}

export interface MediaTransport {
  /** Attach to the `<audio>` or `<video>` this drives. */
  readonly ref: RefObject<HTMLMediaElement | null>;
  readonly state: MediaTransportState;
  readonly controls: MediaTransportControls;
}

const IDLE: MediaTransportState = {
  playing: false,
  currentSeconds: 0,
  durationSeconds: undefined,
  muted: false,
  ready: false,
};

export function useMediaTransport(src: string | undefined): MediaTransport {
  const ref = useRef<HTMLMediaElement | null>(null);
  const [state, setState] = useState<MediaTransportState>(IDLE);

  useEffect(() => {
    const element = ref.current;
    // Reset on every source change, including to nothing. A previous file's position and duration
    // shown against a newly selected one is a scrubber that starts half way through an untouched file.
    setState(IDLE);
    if (element === null || src === undefined) return;

    const read = (): void => {
      setState({
        playing: !element.paused && !element.ended,
        currentSeconds: element.currentTime,
        durationSeconds: scrubbableDuration(element.duration),
        muted: element.muted,
        ready: element.readyState >= 1,
      });
    };

    // One listener per thing that can change the answer. `emptied` and `error` matter as much as the
    // rest: a file that fails to load must not leave the bar showing the last one's length.
    const events = [
      'play',
      'pause',
      'ended',
      'timeupdate',
      'durationchange',
      'loadedmetadata',
      'volumechange',
      'emptied',
      'error',
      'seeked',
    ] as const;

    for (const event of events) element.addEventListener(event, read);
    read();

    return () => {
      for (const event of events) element.removeEventListener(event, read);
    };
  }, [src]);

  const toggle = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    // The promise is deliberately swallowed: a rejected `play()` is an autoplay refusal or a torn-down
    // element, and in both cases the `pause` event that follows already tells the truth.
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    const element = ref.current;
    if (element === null) return;
    element.currentTime = clampSeek(seconds, scrubbableDuration(element.duration));
  }, []);

  const restart = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    element.currentTime = 0;
  }, []);

  const toggleMuted = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    element.muted = !element.muted;
  }, []);

  return { ref, state, controls: { toggle, seek, restart, toggleMuted } };
}
