import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetPath, FrameIndex } from '@nos/core';
import { endExclusive } from '@nos/core';
import type { MaskFrame, MaskSession, SegmentationCapabilities, SegmentationRequest } from '@nos/masks';
import { applyEvent, beginRun, toRequest } from '@nos/masks';
import type { GpuLease, GpuSemaphore } from '@nos/generators';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * Segmentation, connected to the engine that has always been able to do it.
 *
 * The sidecar has implemented SAM 2 propagation since M6 — `/segment/capabilities`, `/segment/start`,
 * a status poll and a cursored frame feed — and the panel asked it nothing. It reported
 * `available: false` with the words "connect a project to check", which was a placeholder that had
 * outlived its placeholder-ness: a project *was* connected, and the panel still said that.
 *
 * The engine's real answer matters more than the feature. SAM 2 is a large optional dependency, so
 * "not installed, install it and restart" is the honest and common case — and it is exactly the
 * answer the sidecar already composes. Reporting it is the same rule the generator registry follows:
 * a capability that silently vanishes costs far more than one that explains itself.
 *
 * Polling rather than a socket. A propagation emits one mask per frame and the sidecar already
 * buffers them behind a cursor, so a poll fetches everything produced since the last one in a single
 * round trip — a socket would add a connection lifecycle to manage for no fewer round trips.
 */

/** How often a running job is asked for more frames. Fast enough to look live, slow enough to idle. */
const POLL_MS = 400;

export interface Segmentation {
  readonly capabilities: SegmentationCapabilities | undefined;
  /** Present while a run is in flight or has failed; the session carries the frames themselves. */
  readonly error: string | undefined;
  run(session: MaskSession, source: AssetPath): void;
  cancel(): void;
}

interface WireStatus {
  readonly job_id: string;
  readonly state: string;
  readonly frames_done: number;
  readonly expected_frames: number;
  readonly progress: number;
  readonly error?: string | null;
}

interface WireFrames {
  readonly job_id: string;
  readonly state: string;
  readonly next_cursor: number;
  readonly frames: readonly {
    readonly frame: number;
    readonly width: number;
    readonly height: number;
    readonly rle: readonly number[];
  }[];
  readonly error?: string | null;
}

export function useSegmentation(
  sidecar: SidecarInfo | undefined,
  onSession: (update: (session: MaskSession) => MaskSession) => void,
  gpu: GpuSemaphore,
): Segmentation {
  const [capabilities, setCapabilities] = useState<SegmentationCapabilities | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const job = useRef<string | undefined>(undefined);

  /*
   * The GPU lease, held for the whole propagation.
   *
   * A ref rather than the `withGpu` wrapper because a run here is not one `await`: it is a POST that
   * starts a job and a poll that drives it to a terminal state, so the lease has to outlive the call
   * that took it. `release` is idempotent by contract, which is what makes releasing from all four
   * exits — start failure, success, engine failure and cancel — safe rather than merely tidy.
   */
  const lease = useRef<GpuLease | undefined>(undefined);
  /** Aborts an acquire that is still queued, so cancelling while waiting does not leave a lease owed. */
  const waiting = useRef<AbortController | undefined>(undefined);

  const releaseGpu = useCallback(() => {
    waiting.current?.abort();
    waiting.current = undefined;
    lease.current?.release();
    lease.current = undefined;
  }, []);

  // Asked once per sidecar. The answer depends on what is installed in the sidecar's environment,
  // which cannot change while it is running — re-asking on every render would be a request per frame
  // of an animation to learn something that is fixed for the process's lifetime.
  useEffect(() => {
    if (sidecar === undefined || !sidecar.available) {
      setCapabilities(undefined);
      return;
    }

    let cancelled = false;
    void fetch(`${sidecar.baseUrl}/segment/capabilities`, { headers: headers(sidecar) })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { available?: boolean; propagates?: boolean; detail?: string } | undefined) => {
        if (cancelled || body === undefined) return;
        setCapabilities({
          available: body.available === true,
          propagates: body.propagates === true,
          detail: body.detail ?? '',
        });
      })
      .catch(() => {
        if (!cancelled) {
          setCapabilities({
            available: false,
            propagates: false,
            detail: 'the media sidecar did not answer',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sidecar]);

  const cancel = useCallback(() => {
    const id = job.current;
    job.current = undefined;
    // Before the early return: a run cancelled while still queued for the GPU has no job id yet, and
    // returning first would leave the card reserved for a propagation that will never start.
    releaseGpu();
    if (id === undefined || sidecar === undefined) return;
    void fetch(`${sidecar.baseUrl}/segment/${id}/cancel`, {
      method: 'POST',
      headers: headers(sidecar),
    }).catch(() => undefined);
    onSession((session) =>
      applyEvent(session, { kind: 'done', result: { ok: false, error: { kind: 'cancelled' } } }),
    );
  }, [onSession, releaseGpu, sidecar]);

  /**
   * Asks the engine to begin, once the card is ours.
   *
   * Split from `run` so the acquire reads as one step and the submit as another: the lease is taken
   * first and unconditionally, and everything that can fail about the request happens while holding it.
   */
  const startRun = useCallback(
    async (id: string, session: MaskSession, request: SegmentationRequest): Promise<void> => {
      if (sidecar === undefined) return;
      await fetch(`${sidecar.baseUrl}/segment/start`, {
        method: 'POST',
        headers: { ...headers(sidecar), 'content-type': 'application/json' },
        body: JSON.stringify({
          job_id: id,
          source: request.source,
          start_frame: request.range.start,
          end_frame: endExclusive(request.range),
          // Points only: the engine's request takes points, and a box prompt is a different shape
          // it does not accept. Filtered rather than coerced, so a box never arrives as a point in
          // the wrong place.
          points: request.prompts
            .filter((prompt) => prompt.kind === 'point')
            .map((prompt) => ({
              frame: prompt.frame,
              x: prompt.x,
              y: prompt.y,
              include: prompt.include,
            })),
          // The renderer owns the cache key, so the folder has one definition rather than two that
          // have to agree.
          cache_folder: `cache/masks/${session.track.id}`,
        }),
      }).then(async (response) => {
        if (response.ok) return;
        const body = (await response.json().catch(() => undefined)) as { detail?: string } | undefined;
        throw new Error(body?.detail ?? `segmentation failed to start (${response.status})`);
      });
    },
    [sidecar],
  );

  const run = useCallback(
    (session: MaskSession, source: AssetPath) => {
      if (sidecar === undefined || !sidecar.available) {
        setError('the media sidecar is not running');
        return;
      }

      // Built by the session rather than assembled here: it is the one place that knows a run with no
      // prompts is not a run, and returning `undefined` for it keeps that rule in a tested function.
      const request = toRequest(session, source);
      if (request === undefined) {
        setError('click the object first — segmentation needs at least one point');
        return;
      }

      const id = `${session.track.id}-${session.propagation.start}`;
      job.current = id;
      setError(undefined);
      onSession(beginRun);

      /*
       * The card is taken before the engine is asked, per §7: the generator backend, the SAM 2 worker
       * and the graph-embedded LLMs all compete for the same VRAM and are serialized on one semaphore.
       * Propagating while a generation is in flight is precisely the collision that rule prevents, and
       * until now segmentation never acquired at all.
       */
      const queued = new AbortController();
      waiting.current = queued;
      onSession((current) => applyEvent(current, { kind: 'waiting-for-gpu' }));

      void gpu
        .acquire('segmentation', `mask ${session.track.id}`, queued.signal)
        .then((held) => {
          // Cancelled while queued: the run is already over, so the lease is handed straight back
          // rather than held for a propagation nobody is waiting for.
          if (job.current !== id) {
            held.release();
            return undefined;
          }
          lease.current = held;
          waiting.current = undefined;
          return startRun(id, session, request);
        })
        .catch((cause: unknown) => {
          // An aborted acquire is a cancellation, which `cancel` has already reported.
          if (queued.signal.aborted) return;
          releaseGpu();
          job.current = undefined;
          const detail = cause instanceof Error ? cause.message : String(cause);
          setError(detail);
          onSession((current) =>
            applyEvent(current, { kind: 'done', result: { ok: false, error: { kind: 'failed', detail } } }),
          );
        });
    },
    [gpu, onSession, releaseGpu, sidecar, startRun],
  );

  // The poll. One request per tick fetches the status and every mask produced since the cursor, so a
  // run that emits three hundred frames costs three hundred decodes and not three hundred requests.
  useEffect(() => {
    if (sidecar === undefined) return;
    let cursor = 0;
    let stopped = false;

    const tick = async (): Promise<void> => {
      const id = job.current;
      if (id === undefined || stopped) return;

      try {
        const response = await fetch(`${sidecar.baseUrl}/segment/${id}/frames?cursor=${cursor}`, {
          headers: headers(sidecar),
        });
        if (!response.ok) return;

        const body = (await response.json()) as WireFrames;
        cursor = body.next_cursor;

        for (const frame of body.frames) {
          const mask = toMaskFrame(frame);
          if (mask !== undefined) onSession((session) => applyEvent(session, { kind: 'frame', mask }));
        }

        if (body.state === 'running' || body.state === 'queued') {
          const status = await fetch(`${sidecar.baseUrl}/segment/${id}`, { headers: headers(sidecar) })
            .then((r) => (r.ok ? (r.json() as Promise<WireStatus>) : undefined))
            .catch(() => undefined);
          if (status !== undefined) {
            onSession((session) =>
              applyEvent(session, { kind: 'progress', progress: { fraction: status.progress } }),
            );
          }
          return;
        }

        // Terminal. The job is forgotten here rather than on the next tick, so a finished run stops
        // costing a request every 400 ms for as long as the panel stays open.
        job.current = undefined;
        // And the card goes back. This is the release that matters most: without it one propagation
        // would hold the semaphore for the lifetime of the window and every later generation would
        // queue behind a run that finished minutes ago.
        releaseGpu();
        if (body.state === 'failed') {
          const detail = body.error ?? 'the engine failed';
          setError(detail);
          onSession((session) =>
            applyEvent(session, { kind: 'done', result: { ok: false, error: { kind: 'failed', detail } } }),
          );
        } else {
          const first = body.frames[body.frames.length - 1];
          onSession((session) =>
            applyEvent(session, {
              kind: 'done',
              result: {
                ok: true,
                value: {
                  frames: session.frames.size,
                  width: first?.width ?? 0,
                  height: first?.height ?? 0,
                },
              },
            }),
          );
        }
      } catch {
        // A dropped poll is not a failed run: the next tick asks again from the same cursor, and
        // treating a hiccup as an engine failure would throw away masks already produced.
      }
    };

    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [onSession, releaseGpu, sidecar]);

  return { capabilities, error, run, cancel };
}

function headers(sidecar: SidecarInfo): Record<string, string> {
  return { 'x-nos-token': sidecar.token };
}

/**
 * One wire frame as a mask.
 *
 * `undefined` for a run-length encoding that does not decode, rather than a throw: one corrupt frame
 * out of three hundred should cost that frame, not the propagation.
 */
function toMaskFrame(frame: {
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  readonly rle: readonly number[];
}): MaskFrame | undefined {
  if (!Number.isInteger(frame.frame) || frame.width <= 0 || frame.height <= 0) return undefined;
  if (!Array.isArray(frame.rle)) return undefined;
  return {
    frame: frame.frame as FrameIndex,
    width: frame.width,
    height: frame.height,
    counts: frame.rle,
  };
}
