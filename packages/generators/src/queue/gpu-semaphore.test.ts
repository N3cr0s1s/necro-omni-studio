import { describe, expect, it, vi } from 'vitest';
import { GpuAbortError, createGpuSemaphore, describeGpuStatus, withGpu } from './gpu-semaphore.js';

describe('exclusivity', () => {
  it('grants the first request immediately', async () => {
    const semaphore = createGpuSemaphore();
    const lease = await semaphore.acquire('generator', 'stable_audio_3');
    expect(lease.consumer).toBe('generator');
    expect(semaphore.getStatus().holder?.consumer).toBe('generator');
  });

  it('serializes: a second request waits for the first to release', async () => {
    // Serialized rather than pooled, because the failure mode is an out-of-memory abort partway through a
    // job the user already waited minutes for.
    const semaphore = createGpuSemaphore();
    const first = await semaphore.acquire('generator', 'a');

    let secondGranted = false;
    const second = semaphore.acquire('segmentation', 'mask').then((lease) => {
      secondGranted = true;
      return lease;
    });

    await Promise.resolve();
    expect(secondGranted).toBe(false);
    expect(semaphore.getStatus().waiting).toHaveLength(1);

    first.release();
    await second;
    expect(secondGranted).toBe(true);
  });

  it('hands turns out in order', async () => {
    const semaphore = createGpuSemaphore();
    const held = await semaphore.acquire('generator', 'first');

    const order: string[] = [];
    const pending = [
      semaphore.acquire('segmentation', 'second').then((lease) => {
        order.push('second');
        lease.release();
      }),
      semaphore.acquire('llm', 'third').then((lease) => {
        order.push('third');
        lease.release();
      }),
    ];

    held.release();
    await Promise.all(pending);
    expect(order).toEqual(['second', 'third']);
  });

  it('is idle again after the last release', async () => {
    const semaphore = createGpuSemaphore();
    const lease = await semaphore.acquire('export', 'render');
    lease.release();
    expect(semaphore.getStatus().holder).toBeUndefined();
  });
});

describe('release safety', () => {
  it('is idempotent, so a double release cannot let two jobs run at once', async () => {
    // A `finally` plus an explicit release is a normal pattern; handing the next turn out twice would run
    // two GPU jobs concurrently, which is exactly what the semaphore exists to prevent.
    const semaphore = createGpuSemaphore();
    const first = await semaphore.acquire('generator', 'a');

    const granted: string[] = [];
    const second = semaphore.acquire('generator', 'b').then((lease) => {
      granted.push('b');
      return lease;
    });
    const third = semaphore.acquire('generator', 'c').then((lease) => {
      granted.push('c');
      return lease;
    });

    first.release();
    first.release();
    await second;

    expect(granted).toEqual(['b']);
    (await second).release();
    await third;
    expect(granted).toEqual(['b', 'c']);
  });
});

describe('cancellation', () => {
  it('rejects a request whose signal is already aborted', async () => {
    const semaphore = createGpuSemaphore();
    const controller = new AbortController();
    controller.abort();
    await expect(semaphore.acquire('generator', 'a', controller.signal)).rejects.toBeInstanceOf(
      GpuAbortError,
    );
  });

  it('removes a queued request when it is cancelled', async () => {
    // A cancelled job must not take a turn it no longer wants, or everything behind it waits for the
    // duration of a run that will never happen.
    const semaphore = createGpuSemaphore();
    const held = await semaphore.acquire('generator', 'holding');

    const controller = new AbortController();
    const cancelled = semaphore.acquire('generator', 'doomed', controller.signal);
    const after = semaphore.acquire('segmentation', 'next');

    expect(semaphore.getStatus().waiting).toHaveLength(2);
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(GpuAbortError);
    expect(semaphore.getStatus().waiting).toHaveLength(1);

    held.release();
    const lease = await after;
    // The turn goes to the request that is still wanted.
    expect(lease.label).toBe('next');
  });

  it('does not disturb a lease already granted when its signal aborts later', async () => {
    const semaphore = createGpuSemaphore();
    const controller = new AbortController();
    const lease = await semaphore.acquire('generator', 'a', controller.signal);
    controller.abort();
    // Still the holder: aborting cancels a *wait*, not work already under way.
    expect(semaphore.getStatus().holder?.label).toBe('a');
    lease.release();
  });
});

describe('status reporting', () => {
  it('names the holder, so a waiting job can say what it is waiting for', async () => {
    // The mockups show generator jobs waiting while segmentation holds the GPU — stated, not hidden.
    const semaphore = createGpuSemaphore();
    const lease = await semaphore.acquire('segmentation', 'broll_city · 03');
    expect(semaphore.getStatus().holder).toEqual({
      consumer: 'segmentation',
      label: 'broll_city · 03',
    });
    lease.release();
  });

  it('lists waiters with how long they have waited', async () => {
    let clock = 1000;
    const semaphore = createGpuSemaphore(() => clock);
    const held = await semaphore.acquire('generator', 'a');

    clock = 1500;
    void semaphore.acquire('llm', 'prompt expansion');

    const waiting = semaphore.getStatus().waiting;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.since).toBe(1500);
    held.release();
  });

  it('notifies subscribers on grant and release', async () => {
    const semaphore = createGpuSemaphore();
    const listener = vi.fn();
    semaphore.subscribe(listener);

    const lease = await semaphore.acquire('generator', 'a');
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    lease.release();
    expect(listener).toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', async () => {
    const semaphore = createGpuSemaphore();
    const listener = vi.fn();
    const unsubscribe = semaphore.subscribe(listener);
    unsubscribe();
    (await semaphore.acquire('generator', 'a')).release();
    expect(listener).not.toHaveBeenCalled();
  });

  it('describes the state for the title bar', async () => {
    const semaphore = createGpuSemaphore();
    expect(describeGpuStatus(semaphore.getStatus())).toBe('GPU idle');

    const lease = await semaphore.acquire('segmentation', 'mask');
    expect(describeGpuStatus(semaphore.getStatus())).toBe('GPU busy · segmentation');

    void semaphore.acquire('generator', 'queued');
    expect(describeGpuStatus(semaphore.getStatus())).toBe('GPU busy · segmentation · 1 queued');
    lease.release();
  });
});

describe('withGpu', () => {
  it('releases after the work resolves', async () => {
    const semaphore = createGpuSemaphore();
    const result = await withGpu(semaphore, 'generator', 'a', async () => 42);
    expect(result).toBe(42);
    expect(semaphore.getStatus().holder).toBeUndefined();
  });

  it('releases when the work throws, so a failure cannot strand the GPU', async () => {
    // A leaked lease would deadlock every generator, mask and export for the rest of the session — the
    // single worst failure this component can have.
    const semaphore = createGpuSemaphore();
    await expect(
      withGpu(semaphore, 'generator', 'a', async () => {
        throw new Error('the graph blew up');
      }),
    ).rejects.toThrow('the graph blew up');

    expect(semaphore.getStatus().holder).toBeUndefined();
    // The next request is granted immediately, proving nothing is stranded.
    const lease = await semaphore.acquire('segmentation', 'next');
    expect(lease.label).toBe('next');
  });

  it('serializes concurrent work', async () => {
    const semaphore = createGpuSemaphore();
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        withGpu(semaphore, 'generator', `job${index}`, async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 1));
          concurrent -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
  });
});

/*
 * The snapshot's identity, which is a contract and not an implementation detail.
 *
 * `getStatus` built a fresh object per call. Every existing test passed, because they all compare by
 * value — and the first consumer to treat this as what it is, a subscribable store, could not use it:
 * React's `useSyncExternalStore` decides whether to re-render by comparing snapshots *by identity*, so
 * a store that never returns the same object twice reports a change on every render.
 *
 * A store that publishes to listeners owes them a stable value between publishes.
 */
describe('the status snapshot', () => {
  it('is the same object until something changes', () => {
    const semaphore = createGpuSemaphore();
    expect(semaphore.getStatus()).toBe(semaphore.getStatus());
  });

  it('is a new object once something has', async () => {
    const semaphore = createGpuSemaphore();
    const before = semaphore.getStatus();
    const lease = await semaphore.acquire('segmentation', 'mask_0');

    expect(semaphore.getStatus()).not.toBe(before);
    expect(semaphore.getStatus()).toBe(semaphore.getStatus());

    lease.release();
    expect(semaphore.getStatus()).not.toBe(before);
  });

  it('hands listeners the very object a later read returns', async () => {
    // Otherwise a subscriber that stores what it was given disagrees with one that asks — the two
    // halves of the same store reporting different values for the same moment.
    const semaphore = createGpuSemaphore();
    const seen: unknown[] = [];
    semaphore.subscribe((status) => seen.push(status));

    const lease = await semaphore.acquire('export', 'out.mp4');
    expect(seen.at(-1)).toBe(semaphore.getStatus());
    lease.release();
    expect(seen.at(-1)).toBe(semaphore.getStatus());
  });
});
