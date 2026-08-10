import { describe, expect, it } from 'vitest';
import { createGpuSemaphore } from '@nos/generators';
import { gpuStatusNote } from './use-gpu-status.js';

/**
 * What the shell says about the one GPU.
 *
 * §7 makes the semaphore mandatory and mockup 1e says its state must be *shown, not hidden* — the
 * whole point being that a generator waiting on the segmentation worker looks, without it, like a
 * generator that has stopped. `describeGpuStatus` existed for this and was rendered nowhere.
 *
 * Driven through a real semaphore rather than hand-written status objects: the question is what the
 * bar says while work is actually queued behind a lease, and a literal would only assert that the
 * describer was called with what this test already decided.
 */
describe('the GPU readout', () => {
  it('says nothing while the card is idle and nothing wants it', async () => {
    // A permanent `GPU idle` is a line that says the same thing during every second of editing, which
    // is most of them — and a status area that is always full is one nobody reads when it changes.
    expect(gpuStatusNote(createGpuSemaphore().getStatus())).toBeUndefined();
  });

  it('says nothing before a semaphore exists', () => {
    expect(gpuStatusNote(undefined)).toBeUndefined();
  });

  it('names the holder, which is the answer to "why has nothing happened"', async () => {
    const gpu = createGpuSemaphore();
    await gpu.acquire('segmentation', 'broll_city · mask_0');

    expect(gpuStatusNote(gpu.getStatus())).toContain('segmentation');
  });

  it('counts what is waiting behind it, so a queue is not silent', async () => {
    const gpu = createGpuSemaphore();
    const lease = await gpu.acquire('segmentation', 'mask_0');
    // Not awaited: this is the generation that sits at `queued` with no explanation.
    void gpu.acquire('generator', 't2v_0117');

    const note = gpuStatusNote(gpu.getStatus());
    expect(note).toContain('segmentation');
    expect(note).toContain('1 queued');

    lease.release();
  });

  it('falls quiet again once the card is free', async () => {
    const gpu = createGpuSemaphore();
    const lease = await gpu.acquire('export', 'out.mp4');
    lease.release();

    expect(gpuStatusNote(gpu.getStatus())).toBeUndefined();
  });
});
