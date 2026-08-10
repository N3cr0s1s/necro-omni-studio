import { useEffect, useState, useSyncExternalStore } from 'react';
import { type GpuSemaphore, type GpuStatus, describeGpuStatus } from '@nos/generators';

/**
 * What the one GPU is doing, on screen.
 *
 * §7 makes the semaphore a *mandatory technical decision*: three consumers compete for the card — the
 * generator backend, the SAM 2 worker, and the LLMs built into generator graphs — and one central
 * semaphore serializes them. The mockups put its state in the shell, and 1e says why in as many words:
 * *"while the segmentation worker holds the GPU semaphore, generator jobs wait — **shown, not
 * hidden**"*.
 *
 * It was hidden. `describeGpuStatus` was written with `GPU busy · segmentation` in its own doc comment
 * as the readout "for the title bar", tested, and rendered nowhere — so a queued generation sat at
 * *queued* with nothing anywhere saying that a mask was propagating and had the card. The waiting was
 * correct and unexplained, which is the state a user reads as the application having hung.
 *
 * Serialization itself works: the semaphore is created once per window and the queue, the export and
 * segmentation all go through it. This is the readout alone.
 */

/**
 * The readout, or nothing when there is nothing worth saying.
 *
 * Silent while the GPU is idle **and** nothing is waiting for it. A permanent `GPU idle` would be a
 * line of chrome that is only ever noise: it says the same thing during every second of editing, which
 * is most of them, and a status area that is always full is one nobody reads when it finally changes.
 *
 * Anything else is said. A holder explains why other work has stopped; a queue with no holder is the
 * moment between a release and the next acquire, and reporting it as idle would flicker `GPU idle`
 * into a bar that is about to say `busy` again.
 */
export function gpuStatusNote(status: GpuStatus | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (status.holder === undefined && status.waiting.length === 0) return undefined;
  return describeGpuStatus(status);
}

/**
 * Subscribes to the window's semaphore.
 *
 * Through `useSyncExternalStore`, because the semaphore is exactly that: a value that changes outside
 * React and is read during render. The alternative — an effect that copies the status into state —
 * would show a stale holder for one frame every time a lease changed hands, which on a queue of short
 * jobs is most of them.
 */
export function useGpuStatus(gpu: GpuSemaphore | undefined): GpuStatus | undefined {
  // Kept so the subscription is re-established if the semaphore is ever swapped. It is created once
  // per window today; a hook that quietly depended on that would break the day it is not.
  const [current, setCurrent] = useState<GpuSemaphore | undefined>(gpu);
  useEffect(() => setCurrent(gpu), [gpu]);

  return useSyncExternalStore(
    (onChange) => (current === undefined ? () => undefined : current.subscribe(onChange)),
    () => current?.getStatus(),
    () => undefined,
  );
}
