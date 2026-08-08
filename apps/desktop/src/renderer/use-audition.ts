import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetPath } from '@nos/core';
import type { SidecarInfo } from '../main/ipc-contract.js';
import { fileUrl } from './file-url.js';

/**
 * Listening to a generated variant before accepting it.
 *
 * The picker has had an audition control since M9 and nothing was wired to it, so the only way to
 * hear a generated sound was to accept it onto the timeline and play from there — which is exactly
 * backwards, since accepting is the decision the audition exists to inform.
 *
 * Deliberately an element rather than the mix engine. What is being auditioned is *one file*, before
 * it is a clip: it has no track, no gain automation and no place on the timeline, and routing it
 * through the mixer would mean inventing all three to throw them away.
 */

export interface Audition {
  /** True while something is playing, so a control can show the state rather than a guess. */
  readonly playing: boolean;
  readonly error: string | undefined;
  /** Plays the asset, or stops it if it is the one already playing. */
  toggle(asset: AssetPath | undefined): void;
  stop(): void;
}

export function useAudition(sidecar: SidecarInfo | undefined): Audition {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const element = useRef<HTMLAudioElement | undefined>(undefined);
  const current = useRef<AssetPath | undefined>(undefined);

  const stop = useCallback(() => {
    element.current?.pause();
    current.current = undefined;
    setPlaying(false);
  }, []);

  const toggle = useCallback(
    (asset: AssetPath | undefined) => {
      if (asset === undefined || sidecar === undefined || !sidecar.available) return;

      // The same asset again means stop, which is what a single control has to mean — a second press
      // that restarted from the beginning would make comparing two variants impossible.
      if (current.current === asset && playing) {
        stop();
        return;
      }

      const audio = element.current ?? new Audio();
      element.current = audio;
      audio.onended = () => setPlaying(false);
      audio.onerror = () => {
        // Named rather than silent: the usual cause is a generated file that never arrived, and
        // "nothing happened" is indistinguishable from a broken button.
        setError(`${asset} could not be played`);
        setPlaying(false);
      };

      const url = fileUrl(sidecar, asset);
      if (url === undefined) return;
      audio.src = url;
      current.current = asset;
      setError(undefined);
      void audio
        .play()
        .then(() => setPlaying(true))
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          setPlaying(false);
        });
    },
    [playing, sidecar, stop],
  );

  // Released on teardown, or the element keeps a decoder and a socket open for the life of the window.
  useEffect(() => {
    return () => {
      element.current?.pause();
      element.current?.removeAttribute('src');
      element.current = undefined;
    };
  }, []);

  return { playing, error, toggle, stop };
}
