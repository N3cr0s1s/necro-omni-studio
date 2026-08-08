// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatorId, presetId } from '@nos/core';
import type { GeneratorManifest, RegistryRecord } from '@nos/generators';
import { entriesFor } from '@nos/generators';
import { GeneratorPanel } from './GeneratorPanel.js';

afterEach(cleanup);

function manifest(overrides: Partial<GeneratorManifest> = {}): GeneratorManifest {
  return {
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
    params: [
      { key: 'description', label: 'Description', type: 'text', multiline: true, bind: '/a' },
      { key: 'category', label: 'Category', type: 'enum', options: ['Music', 'SFX'], default: 'Music', bind: '/b' },
      { key: 'duration_s', label: 'Length', type: 'float', min: 1, max: 60, default: 50, bind: '/c' },
      { key: 'enhance', label: 'Enhance', type: 'bool', default: false, bind: '/d' },
      { key: 'seed', type: 'seed', bind: '/e' },
    ],
    presets: [
      { id: presetId('music'), name: 'Music', pin: { category: 'Music' } },
      { id: presetId('sfx'), name: 'SFX', pin: { category: 'SFX', duration_s: 5 } },
    ],
    ...overrides,
  };
}

function record(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  const base = manifest();
  return {
    manifest: base,
    status: 'available',
    reasons: [],
    entries: entriesFor(base),
    ...overrides,
  };
}

const renderPanel = (overrides: Partial<Parameters<typeof GeneratorPanel>[0]> = {}) =>
  render(<GeneratorPanel record={record()} params={{}} {...overrides} />);

describe('manifest-driven rendering', () => {
  it('renders a control per declared parameter, with no per-generator code', () => {
    // The whole framework rests on this: a new generator is a JSON file, not a component.
    renderPanel();
    expect(screen.getByLabelText('Description')).toBeDefined();
    expect(screen.getByLabelText('Category')).toBeDefined();
    expect(screen.getByLabelText('Length')).toBeDefined();
    expect(screen.getByLabelText('Enhance')).toBeDefined();
  });

  it('picks the control from the declared type', () => {
    renderPanel();
    expect(screen.getByLabelText('Description').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Category').tagName).toBe('SELECT');
    expect(screen.getByRole('switch', { name: 'Enhance' })).toBeDefined();
  });

  it('offers the declared enum options', () => {
    renderPanel();
    const options = [...screen.getByLabelText('Category').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options).toEqual(['Music', 'SFX']);
  });

  it('applies declared defaults', () => {
    renderPanel();
    expect((screen.getByLabelText('Length') as HTMLInputElement).value).toBe('50');
  });

  it('honours declared ranges', () => {
    renderPanel();
    const input = screen.getByLabelText('Length') as HTMLInputElement;
    expect(input.min).toBe('1');
    expect(input.max).toBe('60');
  });

  it('marks a required parameter', () => {
    const withRequired = manifest({
      params: [{ key: 'first_frame', label: 'First frame', type: 'image', required: true, bind: '/x' }],
    });
    renderPanel({ record: record({ manifest: withRequired, entries: entriesFor(withRequired) }) });
    expect(screen.getByText(/First frame/).textContent).toContain('*');
  });
});

describe('capability descriptors', () => {
  it('shows what the generator produces', () => {
    renderPanel();
    expect(screen.getByText('audio')).toBeDefined();
  });

  it('shows what it consumes, with the role that makes it placeable', () => {
    // The role is what determines where the action appears; hiding it leaves the user unable to reason
    // about why a tool is or is not in a menu.
    const i2v = manifest({
      consumes: [{ type: 'image', role: 'first_frame', required: true }],
      produces: 'video',
    });
    renderPanel({ record: record({ manifest: i2v, entries: entriesFor(i2v) }) });
    expect(screen.getByText('image · first_frame')).toBeDefined();
  });

  it('distinguishes declared from discovered length', () => {
    // A discovered-length generator inserts differently, so the user needs to know before running it.
    renderPanel();
    expect(screen.getByText('length declared')).toBeDefined();

    cleanup();
    const tts = manifest({ duration: 'discovered' });
    renderPanel({ record: record({ manifest: tts, entries: entriesFor(tts) }) });
    expect(screen.getByText('length discovered')).toBeDefined();
  });
});

describe('presets', () => {
  it('offers every declared preset', () => {
    renderPanel();
    expect(screen.getByRole('radio', { name: 'Music' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'SFX' })).toBeDefined();
  });

  it('hides parameters the preset pins, so it reads as its own tool', () => {
    renderPanel({ preset: presetId('sfx') });
    expect(screen.queryByLabelText('Category')).toBeNull();
    expect(screen.queryByLabelText('Length')).toBeNull();
    // Unpinned parameters remain.
    expect(screen.getByLabelText('Description')).toBeDefined();
  });

  it('reports a preset selection', async () => {
    const user = userEvent.setup();
    const onChangePreset = vi.fn();
    renderPanel({ onChangePreset });
    await user.click(screen.getByRole('radio', { name: 'SFX' }));
    expect(onChangePreset).toHaveBeenCalledWith('sfx');
  });

  it('deselects a preset when it is clicked again', async () => {
    const user = userEvent.setup();
    const onChangePreset = vi.fn();
    renderPanel({ preset: presetId('sfx'), onChangePreset });
    await user.click(screen.getByRole('radio', { name: 'SFX' }));
    expect(onChangePreset).toHaveBeenCalledWith(undefined);
  });

  it('shows no preset chooser when the manifest declares none', () => {
    const plain = manifest({ presets: [] });
    renderPanel({ record: record({ manifest: plain, entries: entriesFor(plain) }) });
    expect(screen.queryByRole('radiogroup', { name: 'Preset' })).toBeNull();
  });
});

describe('variants', () => {
  it('defaults to the manifest count', () => {
    renderPanel();
    expect((screen.getByLabelText('Variant count') as HTMLInputElement).value).toBe('3');
  });

  it('disables the count and explains why when there is no seed parameter', () => {
    // The spec requires the reason to be shown rather than silently returning identical results.
    const noSeed = manifest({ params: [{ key: 'description', type: 'text', bind: '/a' }] });
    renderPanel({
      record: record({ manifest: noSeed, entries: entriesFor(noSeed) }),
      variantCount: 3,
    });

    expect((screen.getByLabelText('Variant count') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/no seed parameter/)).toBeDefined();
  });

  it('disables the count and explains why when the seed is locked', () => {
    renderPanel({ variantCount: 3, lockedSeed: 4471 });
    expect((screen.getByLabelText('Variant count') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/seed is locked/)).toBeDefined();
  });

  it('shows the execution mode, so batching is not invisible', () => {
    renderPanel();
    expect(screen.getByText('sequential')).toBeDefined();

    cleanup();
    const batched = manifest({ batch: { bind: '/batch', max: 4 } });
    renderPanel({ record: record({ manifest: batched, entries: entriesFor(batched) }) });
    expect(screen.getByText('batched')).toBeDefined();
  });

  it('reports a variant count change', async () => {
    const user = userEvent.setup();
    const onChangeVariantCount = vi.fn();
    renderPanel({ onChangeVariantCount });

    const input = screen.getByLabelText('Variant count');
    await user.clear(input);
    await user.type(input, '5');

    expect(onChangeVariantCount).toHaveBeenCalled();
  });

  it('names the variant count on the run button', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /Generate 3 variants/ })).toBeDefined();
  });
});

describe('seed control', () => {
  it('shows random until the seed is locked', () => {
    renderPanel();
    expect(screen.getByText('random')).toBeDefined();
  });

  it('reports a lock toggle', async () => {
    const user = userEvent.setup();
    const onToggleSeedLock = vi.fn();
    renderPanel({ onToggleSeedLock });
    await user.click(screen.getByRole('button', { name: 'lock' }));
    expect(onToggleSeedLock).toHaveBeenCalled();
  });

  it('explains what locking does', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'lock' }).getAttribute('title')).toContain('identical');
  });
});

describe('live enum options', () => {
  it('uses backend-supplied options, so model lists reflect reality', () => {
    // A manifest written six months ago must not dictate today's checkpoint list.
    const live = manifest({
      params: [
        {
          key: 'checkpoint',
          label: 'Checkpoint',
          type: 'enum',
          bind: '/ckpt',
          options: { from: 'capabilities', nodeClass: 'CheckpointLoaderSimple', input: 'ckpt_name' },
        },
      ],
    });
    renderPanel({
      record: record({ manifest: live, entries: entriesFor(live) }),
      capabilityOptions: new Map([['CheckpointLoaderSimple/ckpt_name', ['a.safetensors', 'b.safetensors']]]),
    });

    const options = [...screen.getByLabelText('Checkpoint').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options).toEqual(['a.safetensors', 'b.safetensors']);
  });

  it('renders an empty list rather than failing when the backend has not reported', () => {
    const live = manifest({
      params: [
        {
          key: 'checkpoint',
          label: 'Checkpoint',
          type: 'enum',
          bind: '/ckpt',
          options: { from: 'capabilities', nodeClass: 'X', input: 'y' },
        },
      ],
    });
    expect(() =>
      renderPanel({ record: record({ manifest: live, entries: entriesFor(live) }) }),
    ).not.toThrow();
  });
});

describe('unavailable and unbound generators', () => {
  it('stays visible with its reason rather than disappearing', () => {
    // The spec's rule, and the reason it exists: a silently missing tool costs hours.
    renderPanel({
      record: record({
        status: 'unavailable',
        reasons: [{ kind: 'node-class-missing', nodeClass: 'CustomCombo' }],
      }),
    });

    expect(screen.getByText('Stable Audio 3')).toBeDefined();
    expect(screen.getByText(/CustomCombo/)).toBeDefined();
    expect(screen.getByText('unavailable')).toBeDefined();
  });

  it('disables running while unavailable', () => {
    renderPanel({ record: record({ status: 'unavailable', reasons: [] }) });
    expect(screen.getByRole('button', { name: /Generate/ }).hasAttribute('disabled')).toBe(true);
  });

  it('disables the parameter controls too', () => {
    renderPanel({ record: record({ status: 'unavailable', reasons: [] }) });
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('distinguishes unbound from broken', () => {
    // Not connected yet is a to-do; broken is a bug. Different wording, different user response.
    renderPanel({ record: record({ status: 'unbound', reasons: [] }) });
    expect(screen.getByText('graph not connected')).toBeDefined();
    expect(screen.getByText(/not connected yet/)).toBeDefined();
  });
});

describe('parameter changes', () => {
  it('reports a text change', async () => {
    const user = userEvent.setup();
    const onChangeParam = vi.fn();
    renderPanel({ onChangeParam });
    await user.type(screen.getByLabelText('Description'), 'a');
    expect(onChangeParam).toHaveBeenCalledWith('description', 'a');
  });

  it('reports a boolean toggle', async () => {
    const user = userEvent.setup();
    const onChangeParam = vi.fn();
    renderPanel({ onChangeParam });
    await user.click(screen.getByRole('switch', { name: 'Enhance' }));
    expect(onChangeParam).toHaveBeenCalledWith('enhance', true);
  });

  it('reports an enum change', async () => {
    const user = userEvent.setup();
    const onChangeParam = vi.fn();
    renderPanel({ onChangeParam });
    await user.selectOptions(screen.getByLabelText('Category'), 'SFX');
    expect(onChangeParam).toHaveBeenCalledWith('category', 'SFX');
  });

  it('reports a run request', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderPanel({ onRun });
    await user.click(screen.getByRole('button', { name: /Generate/ }));
    expect(onRun).toHaveBeenCalled();
  });
});
