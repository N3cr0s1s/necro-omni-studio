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
  return {
    id: jobRunId(id),
    group: group.id,
    seed: 1,
    seeds: [1],
    status: 'queued',
    outputs: [],
    ...overrides,
  };
}

const done = (id: string, seed: number): JobRun =>
  run(id, {
    seed,
    status: 'complete',
    outputs: [{ key: '57', type: 'audio', path: assetPath(`generated/${id}.flac`) }],
  });

const selectionOf = (runs: readonly JobRun[], current?: string) =>
  buildSelection({ group, runs, manifest, ...(current !== undefined ? { current } : {}) });

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
    expect(screen.getByRole('group', { name: 'Variant' }).querySelectorAll('button')).toHaveLength(3);
  });

  it('says how many are still coming', () => {
    renderPicker({ selection: selectionOf(partial) });
    expect(screen.getByText('1 / 3 · 2 still generating')).toBeDefined();
  });

  it('names a pending chip by its state, not by number alone', () => {
    renderPicker({ selection: selectionOf(partial) });
    expect(screen.getByRole('button', { name: 'Variant 2 generating' })).toBeDefined();
  });

  it('marks a failed variant', () => {
    const failed = [done('r1', 11), run('r2', { status: 'failed', error: 'out of memory' })];
    renderPicker({ selection: selectionOf(failed) });
    expect(screen.getByRole('button', { name: 'Variant 2 failed' })).toBeDefined();
  });

  it('shows the seed, which is what makes a variant reproducible', () => {
    renderPicker({ selection: selectionOf(allDone, `${'r2'}#0`) });
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

  it('keeps the way out available throughout, so a slow job is never a trap', () => {
    renderPicker({ selection: selectionOf([run('r1')]) });
    expect(screen.getByRole('button', { name: 'Dismiss all' }).hasAttribute('disabled')).toBe(false);
  });

  it('says the files stay', () => {
    // The spec leaves unaccepted variants in `generated/`; a user who thinks this deletes them will not
    // press it.
    renderPicker();
    expect(screen.getByRole('button', { name: 'Dismiss all' }).getAttribute('title')).toContain('stay');
  });

  it('says it acts on the whole group, not on the selected take', () => {
    // "Discard" beside a per-variant "Keep" reads as *discard this variant*, and it is not — someone
    // rejecting take 2 to compare 1 against 3 pressed it and lost the picker.
    renderPicker();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss all' })).toBeDefined();
  });

  it('disables stepping when only one variant is ready', () => {
    renderPicker({ selection: selectionOf(partial) });
    expect(screen.getByRole('button', { name: 'Previous variant' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Next variant' }).hasAttribute('disabled')).toBe(true);
  });

  it('disables a chip that is not ready', () => {
    renderPicker({ selection: selectionOf(partial) });
    const pendingChip = screen.getByRole('button', { name: 'Variant 2 generating' });
    expect(pendingChip.hasAttribute('disabled')).toBe(true);
  });
});

describe('interaction', () => {
  it('reports a chip selection', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    await user.click(screen.getByRole('button', { name: 'Variant 3' }));
    // The candidate's key, not its run: three variants of a batched submit share a run id.
    expect(onSelect).toHaveBeenCalledWith('r3#0');
  });

  it('steps to the next candidate and reports it by key', async () => {
    // A **key**, not a delta and not a run. Reporting a delta left the caller to work out which
    // candidate it landed on, and the caller answered with the candidate's *run* — which no key ever
    // equals, so every step silently fell back to the first variant.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    await user.click(screen.getByRole('button', { name: 'Next variant' }));
    expect(onSelect).toHaveBeenCalledWith('r2#0');
  });

  it('wraps backwards from the first to the last', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    await user.click(screen.getByRole('button', { name: 'Previous variant' }));
    expect(onSelect).toHaveBeenCalledWith('r3#0');
  });

  it('steps from wherever the selection actually is', async () => {
    // The case the old shape got wrong in the application: standing on variant 3, stepping back has to
    // reach variant 2 rather than restarting from the beginning.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ selection: selectionOf(allDone, 'r3#0'), onSelect });
    await user.click(screen.getByRole('button', { name: 'Previous variant' }));
    expect(onSelect).toHaveBeenCalledWith('r2#0');
  });

  it('steps with the arrow keys, since comparing is a back-and-forth', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    screen.getByRole('group', { name: /Variants/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('r2#0');
  });

  it('steps with the arrows while a chip has focus, which is when comparing happens', async () => {
    // The moment after a click the focus is inside the toggle group, and its own roving focus ate the
    // arrows — so the back-and-forth stopped working exactly when a user was doing it.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    screen.getByRole('button', { name: 'Variant 1' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('r2#0');
  });

  it('says nothing when there is nowhere to step', async () => {
    // One ready variant: reporting the same key would be a state change the caller has to no-op.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ selection: selectionOf([done('r1', 11)]), onSelect });
    await user.click(screen.getByRole('button', { name: 'Next variant' }));
    expect(onSelect).not.toHaveBeenCalled();
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
    await user.click(screen.getByRole('button', { name: 'Dismiss all' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('the placeholder body', () => {
  it('shows how many variants have landed', () => {
    render(<VariantPlaceholder selection={selectionOf(partial)} left={40} width={200} height={56} />);
    expect(screen.getByText('1/3')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Warehouse drone placeholder' })).toBeDefined();
  });

  it('draws a dashed edge while the length is provisional', () => {
    // A solid edge would claim a precision a discovered-length manifest does not have.
    render(
      <VariantPlaceholder selection={selectionOf(partial)} left={0} width={80} height={56} provisional />,
    );
    const body = screen.getByRole('button', { name: /placeholder/ });
    expect(body.className).toContain('border-dashed');
  });

  it('stays clickable at any zoom', () => {
    // A zero-width placeholder would be unselectable, which is exactly when a user wants to cancel it.
    render(<VariantPlaceholder selection={selectionOf(partial)} left={0} width={0} height={56} />);
    expect(screen.getByRole('button', { name: /placeholder/ }).style.width).toBe('2px');
  });
});
