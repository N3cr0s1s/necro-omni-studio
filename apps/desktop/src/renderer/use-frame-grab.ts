import { useCallback, useMemo, useState } from 'react';
import type { AssetPath, FrameIndex, TimelineDocument } from '@nos/core';
import { describeFrameGrab, frameGrabTarget } from '@nos/editing';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * Grabbing the frame under the playhead as a project file.
 *
 * Asked for directly: an image-to-video generator wanted a first frame, and the only way to give it
 * one was to have an image lying in the project already. The frame the user is looking at is very
 * often the one they mean — the last frame of the previous shot, a pose in the middle of a take —
 * and exporting it by hand, finding it, and coming back is the round trip that makes one tool feel
 * like three.
 *
 * The decision of *what* is under the playhead lives in `@nos/editing`, where it is testable without
 * a decoder. This hook is the part that cannot be: an ffmpeg call through the sidecar, a bit of
 * pending state, and the error the caller shows.
 */

export interface FrameGrab {
  /** What a grab would capture, e.g. `frame 137 of take.mp4`. `undefined` when nothing is under it. */
  readonly available: string | undefined;
  readonly busy: boolean;
  /** The last failure, kept until the next attempt so a flash of red is not the only warning. */
  readonly error: string | undefined;
  /** Writes the frame and resolves with its path, or `undefined` when it could not be written. */
  grab(): Promise<AssetPath | undefined>;
}

export function useFrameGrab(
  document: TimelineDocument,
  playhead: FrameIndex,
  sidecar: SidecarInfo | undefined,
): FrameGrab {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const target = useMemo(() => frameGrabTarget(document, playhead), [document, playhead]);

  const grab = useCallback(async (): Promise<AssetPath | undefined> => {
    if (target === undefined) return undefined;
    if (sidecar === undefined || !sidecar.available) {
      setError('the media sidecar is not running');
      return undefined;
    }

    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`${sidecar.baseUrl}/media/still`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
        body: JSON.stringify({
          asset: target.asset,
          seconds: target.seconds,
          destination: target.destination,
        }),
      });

      if (!response.ok) {
        // The sidecar's own wording, which names the asset and the reason — far more use than a
        // status code, and the two sides already agree on the shape.
        const body = (await response.json().catch(() => undefined)) as
          { readonly detail?: string } | undefined;
        setError(body?.detail ?? `could not grab the frame (${response.status})`);
        return undefined;
      }

      const written = (await response.json()) as { readonly asset: string };
      return written.asset as AssetPath;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [sidecar, target]);

  return {
    available: target === undefined ? undefined : describeFrameGrab(target),
    busy,
    error,
    grab,
  };
}
