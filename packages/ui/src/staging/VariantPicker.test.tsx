// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetPath, frameIndex, generatorId, jobGroupId, jobRunId, trackId } from '@nos/core';
import type { GeneratorManifest, JobGroup, JobRun } from '@nos/generators';
import { buildSelection } from '@nos/generators';
import { VariantPicker, VariantPlaceholder } from './VariantPicker.js';

afterEach(cleanup);

const manifest: GeneratorManifest = {
  id: generatorId('stable_audio_3'),
  name: 'Stable Audio 3',
  backend: 'comfyui',
  graph: 'audio.json',
  produces: 'audio',
  consumes: [],
  surfaces: ['media_browser'],
  duration: 'declared',
  defaultVariants: 3,
  requires: [],
  outputs: [{ key: 'audio', type: 'audio', node: '57' }],
  params: [{ key: 'seed', type: 'seed', bind: '/s' }],
  presets: [],
};

const group: JobGroup = {
  id: jobGroupId('g1'),
  generator: manifest.id,
  label: 'Warehouse drone',
  params: {},
  variantCount: 3,
  target: { kind: 'timeline', track: trackId('t1'), at: frameIndex(120) },
  status: 'running',
  runs: [jobRunId('r1'), jobRunId('r2'), jobRunId('r3')],
  createdAt: 0,
};

function run(id: string, overrides: Partial<JobRun> = {}): JobRun {
  return { id: jobRunId(id), group: group.id, seed: 1, seeds: [1], status: 'queued', outputs: [], ...overrides };
}

const done = (id: string, seed: number): JobRun =>
  run(id, {
    seed,
    status: 'complete',
    outputs: [{ key: '57', type: 'audio', path: assetPath(`generated/${id}.flac`) }],
  });

const selectionOf = (runs: readonly JobRun[], current?: string) =>
  buildSelection({ group, runs, manifest, ...(current !== undefined ? { current: jobRunId(current) } : {}) });

const allDone = [done('r1', 11), done('r2', 22), done('r3', 33)];
const partial = [done('r1', 11), run('r2', { status: 'running', progress: 0.5 }), run('r3')];

const renderPicker = (overrides: Partial<Parameters<typeof VariantPicker>[0]> = {}) =>
  render(<VariantPicker selection={selectionOf(allDone)} {...overrides} />);

describe('rendering', () => {
  it('is a labelled group naming what is being chosen', () => {
    renderPicker();
    expect(screen.getByRole('group', { name: 'Variants for Warehouse drone' })).toBeDefined();
  });

  it('shows the position', () => {
    renderPicker();
    expect(screen.getByText('1 / 3')).toBeDefined();
  });

  it('shows a chip per variant, including ones still generating', () => {
    // A chip list that grew as results arrived would move the target under a clicking finger.
    renderPicker({ selection: selectionOf(partial) });
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('says how many are still coming', () => {
    renderPicker({ selection: selectionOf(partial) });
    expect(screen.getByText('1 / 3 · 2 still generating')).toBeDefined();
  });

  it('names a pending chip by its state, not by number alone', () => {
    renderPicker({ selection: selectionOf(partial) });
    expect(screen.getByRole('radio', { name: 'Variant 2 generating' })).toBeDefined();
  });

  it('marks a failed variant', () => {
    const failed = [done('r1', 11), run('r2', { status: 'failed', error: 'out of memory' })];
    renderPicker({ selection: selectionOf(failed) });
    expect(screen.getByRole('radio', { name: 'Variant 2 failed' })).toBeDefined();
  });

  it('shows the seed, which is what makes a variant reproducible', () => {
    renderPicker({ selection: selectionOf(allDone, 'r2') });
    expect(screen.getByText('22')).toBeDefined();
  });

  it('surfaces the error when every variant failed', () => {
    const failed = [
      run('r1', { status: 'failed', error: 'CUDA out of memory' }),
      run('r2', { status: 'failed' }),
    ];
    renderPicker({ selection: selectionOf(failed) });
    expect(screen.getByText('CUDA out of memory')).toBeDefined();
  });
});

describe('availability', () => {
  it('cannot keep a variant before one is ready', () => {
    const pending = [run('r1'), run('r2'), run('r3')];
    renderPicker({ selection: selectionOf(pending) });
    expect(screen.getByRole('button', { name: 'Keep' }).hasAttribute('disabled')).toBe(true);
  });

  it('explains why keeping is unavailable', () => {
    renderPicker({ selection: selectionOf([run('r1')]) });
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('title')).toContain('ready');
  });

  it('keeps discard available throughout, so a slow job is never a trap', () => {
    renderPicker({ selection: selectionOf([run('r1')]) });
    expect(screen.getByRole('button', { name: 'Discard' }).hasAttribute('disabled')).toBe(false);
  });

  it('says discarding keeps the files', () => {
    // The spec leaves unaccepted variants in `generated/`; a user who thinks Discard deletes them will not
    // press it.
    renderPicker();
    expect(screen.getByRole('button', { name: 'Discard' }).getAttribute('title')).toContain('kept');
  });

  it('disables stepping when only one variant is ready', () => {
    renderPicker({ selection: selectionOf(partial) });
    expect(screen.getByRole('button', { name: '◀' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '▶' }).hasAttribute('disabled')).toBe(true);
  });

  it('disables a chip that is not ready', () => {
    renderPicker({ selection: selectionOf(partial) });
    const pendingChip = screen.getByRole('radio', { name: 'Variant 2 generating' });
    expect(pendingChip.hasAttribute('disabled')).toBe(true);
  });
});

describe('interaction', () => {
  it('reports a chip selection', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    await user.click(screen.getByRole('radio', { name: 'Variant 3' }));
    expect(onSelect).toHaveBeenCalledWith('r3');
  });

  it('reports stepping in both directions', async () => {
    const user = userEvent.setup();
    const onStep = vi.fn();
    renderPicker({ onStep });
    await user.click(screen.getByRole('button', { name: '▶' }));
    await user.click(screen.getByRole('button', { name: '◀' }));
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it('steps with the arrow keys, since comparing is a back-and-forth', async () => {
    const user = userEvent.setup();
    const onStep = vi.fn();
    renderPicker({ onStep });

    screen.getByRole('group', { name: /Variants/ }).focus();
    await user.keyboard('{ArrowRight}{ArrowLeft}');
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it('keeps on Enter and discards on Escape', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const onDiscard = vi.fn();
    renderPicker({ onAccept, onDiscard });

    screen.getByRole('group', { name: /Variants/ }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('does not accept on Enter when nothing is ready', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    renderPicker({ selection: selectionOf([run('r1')]), onAccept });

    screen.getByRole('group', { name: /Variants/ }).focus();
    await user.keyboard('{Enter}');
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('reports auditioning, and reflects that it is playing', async () => {
    const user = userEvent.setup();
    const onAudition = vi.fn();
    const { rerender } = renderPicker({ onAudition });

    await user.click(screen.getByRole('button', { name: 'Audition' }));
    expect(onAudition).toHaveBeenCalled();

    rerender(<VariantPicker selection={selectionOf(allDone)} auditioning onAudition={onAudition} />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDefined();
  });

  it('reports keep and discard', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const onDiscard = vi.fn();
    renderPicker({ onAccept, onDiscard });

    await user.click(screen.getByRole('button', { name: 'Keep' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('the placeholder body', () => {
  it('shows how many variants have landed', () => {
    render(
      <VariantPlaceholder selection={selectionOf(partial)} left={40} width={200} height={56} />,
    );
    expect(screen.getByText('1/3')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Warehouse drone placeholder' })).toBeDefined();
  });

  it('draws a dashed edge while the length is provisional', () => {
    // A solid edge would claim a precision a discovered-length manifest does not have.
    render(
      <VariantPlaceholder selection={selectionOf(partial)} left={0} width={80} height={56} provisional />,
    );
    const body = screen.getByRole('button', { name: /placeholder/ });
    expect(body.style.borderStyle).toBe('dashed');
  });

  it('stays clickable at any zoom', () => {
    // A zero-width placeholder would be unselectable, which is exactly when a user wants to cancel it.
    render(<VariantPlaceholder selection={selectionOf(partial)} left={0} width={0} height={56} />);
    expect(screen.getByRole('button', { name: /placeholder/ }).style.width).toBe('2px');
  });
});
