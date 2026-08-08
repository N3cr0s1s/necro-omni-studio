import { describe, expect, it } from 'vitest';
import { assetPath, generatorId, jobRunId, presetId } from '@nos/core';
import {
  type AssetProvenance,
  assetForProvenance,
  isProvenanceRecord,
  parseProvenance,
  provenancePath,
  provenanceRows,
  serializeProvenance,
} from './asset-provenance.js';

function record(overrides: Partial<AssetProvenance> = {}): AssetProvenance {
  return {
    asset: assetPath('generated/ad0eb912_00001.mp4'),
    generator: generatorId('minimax_h3_t2v'),
    generatorName: 'MiniMax H3 — text to video',
    backend: 'comfyui',
    run: jobRunId('run-9'),
    seed: 4471,
    createdAt: '2026-08-08T09:12:00.000Z',
    params: { prompt: 'a lighthouse at dusk', duration_s: 15, steps: 20 },
    ...overrides,
  };
}

describe('where a record lives', () => {
  it('sits beside the file it describes', () => {
    // A project is a folder: copy the file elsewhere and its provenance goes with it; delete it and
    // nothing is left dangling. An index would be a second source of truth about files the user can
    // move, and it would be wrong within a day.
    expect(provenancePath(assetPath('generated/a.mp4'))).toBe('generated/a.mp4.nos.json');
  });

  it('is recognisable both ways', () => {
    expect(isProvenanceRecord('generated/a.mp4.nos.json')).toBe(true);
    expect(isProvenanceRecord('generated/a.mp4')).toBe(false);
    expect(assetForProvenance('generated/a.mp4.nos.json')).toBe('generated/a.mp4');
    expect(assetForProvenance('generated/a.mp4')).toBeUndefined();
  });
});

describe('round trip', () => {
  it('reads back everything it wrote', () => {
    const parsed = parseProvenance(serializeProvenance(record()));
    expect(parsed.ok && parsed.value).toEqual(record());
  });

  it('is written for a human to read, since it lands in the user’s own folder', () => {
    expect(serializeProvenance(record())).toContain('\n  "generator"');
  });

  it('omits an absent seed rather than inventing one', () => {
    const { seed: _seed, ...rest } = record();
    const parsed = parseProvenance(serializeProvenance(rest as AssetProvenance));
    expect(parsed.ok && 'seed' in parsed.value).toBe(false);
  });
});

describe('reading a record that is not quite right', () => {
  it('refuses text that is not JSON, without taking anything down', () => {
    // The file it describes is still perfectly usable; the worst acceptable outcome is that the
    // panel says nothing, not that the panel breaks.
    const parsed = parseProvenance('not json at all');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.kind).toBe('unreadable');
  });

  it('names what a record is missing', () => {
    const parsed = parseProvenance('{"asset":"generated/a.mp4"}');
    expect(!parsed.ok && parsed.error.kind === 'incomplete' && parsed.error.missing).toEqual([
      'generator',
      'run',
      'createdAt',
    ]);
  });

  it('falls back to the generator id when an older record has no name', () => {
    const parsed = parseProvenance(
      '{"asset":"a.mp4","generator":"t2v","run":"r1","createdAt":"2026-01-01T00:00:00Z"}',
    );
    expect(parsed.ok && parsed.value.generatorName).toBe('t2v');
  });

  it('drops parameter values it cannot display rather than refusing the record', () => {
    const parsed = parseProvenance(
      '{"asset":"a.mp4","generator":"t2v","run":"r1","createdAt":"x","params":{"a":1,"b":{"deep":true}}}',
    );
    expect(parsed.ok && parsed.value.params).toEqual({ a: 1 });
  });
});

describe('what the panel shows', () => {
  it('leads with the generator and the prompt, which is what a result is recognised by', () => {
    const rows = provenanceRows(record());
    expect(rows.slice(0, 2)).toEqual([
      { label: 'generator', value: 'MiniMax H3 — text to video' },
      { label: 'prompt', value: 'a lighthouse at dusk', long: true },
    ]);
  });

  it('finds the prompt whatever the manifest called it', () => {
    const rows = provenanceRows(record({ params: { description: 'a bell' } }));
    expect(rows.find((row) => row.label === 'prompt')?.value).toBe('a bell');
  });

  it('shows every other parameter, since which one mattered is not knowable here', () => {
    const labels = provenanceRows(record()).map((row) => row.label);
    expect(labels).toContain('duration_s');
    expect(labels).toContain('steps');
  });

  it('never repeats the prompt as an ordinary parameter', () => {
    const rows = provenanceRows(record());
    expect(rows.filter((row) => row.value === 'a lighthouse at dusk')).toHaveLength(1);
  });

  it('omits a preset and a seed that were never set', () => {
    const { seed: _seed, preset: _preset, ...bare } = record({ params: {} });
    const rows = provenanceRows(bare as AssetProvenance);
    expect(rows.map((row) => row.label)).toEqual(['generator', 'made', 'run']);
  });

  it('includes a preset when there was one', () => {
    const rows = provenanceRows(record({ preset: presetId('music') }));
    expect(rows.find((row) => row.label === 'preset')?.value).toBe('music');
  });
});
