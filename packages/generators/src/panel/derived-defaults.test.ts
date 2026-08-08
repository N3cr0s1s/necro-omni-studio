import { describe, expect, it } from 'vitest';
import type { GeneratorParam } from '../contracts/manifest.js';
import { defaultFor, isDerivedDefault, parseAspect, resolveDerivedDefault } from './derived-defaults.js';

/** The list ComfyUI's `ResolutionSelector` actually offers, labels and all. */
const OPTIONS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
];

const aspect = (width: number, height: number) =>
  resolveDerivedDefault('project_aspect_ratio', { width, height }, OPTIONS);

describe('reading a ratio out of a label', () => {
  it('tolerates the parenthetical the backend writes', () => {
    // A parser demanding a bare `16:9` would match nothing and leave every default unresolved —
    // silently, which is the worst way for a default to fail.
    expect(parseAspect('16:9 (Widescreen)')).toBeCloseTo(16 / 9, 6);
  });

  it('takes a bare ratio too', () => {
    expect(parseAspect('4:3')).toBeCloseTo(4 / 3, 6);
  });

  it('is nothing for a label with no ratio in it', () => {
    expect(parseAspect('Widescreen')).toBeUndefined();
    expect(parseAspect('0:9')).toBeUndefined();
  });
});

describe('the project’s aspect ratio', () => {
  it('picks widescreen for a 1080p sequence', () => {
    // The case that prompted this: a generator defaulting to 1:1 in a 16:9 project produces output
    // that is pillarboxed the moment it lands on the timeline.
    expect(aspect(1920, 1080)).toBe('16:9 (Widescreen)');
  });

  it('picks the portrait option for a vertical sequence', () => {
    // Orientation is part of the shape. Handing a portrait project `16:9` because its label sorts
    // first among near matches is exactly the wrong answer.
    expect(aspect(1080, 1920)).toBe('9:16 (Portrait Widescreen)');
  });

  it('picks square for a square sequence', () => {
    expect(aspect(1080, 1080)).toBe('1:1 (Square)');
  });

  it('picks ultrawide for a 21:9 sequence', () => {
    expect(aspect(2560, 1080)).toBe('21:9 (Ultrawide)');
  });

  it('takes the nearest option for a shape nothing matches exactly', () => {
    // 5:4 is between 1:1 and 4:3, and closer to 4:3.
    expect(aspect(1280, 1024)).toBe('4:3 (Standard)');
  });

  it('is symmetric between wider and taller, which a linear comparison is not', () => {
    // Compared on the log of the ratio: twice as wide and half as wide must be equally far away, or
    // the choice is biased toward wide options for every tall project.
    expect(aspect(1000, 500)).toBe(
      aspect(500, 1000) === '1:1 (Square)' ? aspect(1000, 500) : '16:9 (Widescreen)',
    );
    expect(aspect(500, 1000)).toBe('9:16 (Portrait Widescreen)');
  });

  it('is nothing when there is nothing on offer', () => {
    // An empty list means the backend has not answered yet. Guessing at a value not in the list
    // would leave a select with no selection, which reads as a broken control.
    expect(resolveDerivedDefault('project_aspect_ratio', { width: 1920, height: 1080 }, [])).toBeUndefined();
  });

  it('is nothing for a project with no shape', () => {
    expect(aspect(0, 0)).toBeUndefined();
  });
});

describe('which default wins', () => {
  const param = (overrides: Partial<GeneratorParam>): GeneratorParam => ({
    key: 'aspect_ratio',
    type: 'enum',
    bind: '/115/inputs/aspect_ratio',
    ...overrides,
  });

  it('is the derivation when it resolves, since it was chosen knowing the project', () => {
    const resolved = defaultFor(
      param({ defaultFrom: 'project_aspect_ratio', default: '1:1 (Square)' }),
      { width: 1920, height: 1080 },
      OPTIONS,
    );
    expect(resolved).toBe('16:9 (Widescreen)');
  });

  it('falls back to the manifest’s own default when the derivation cannot resolve', () => {
    const resolved = defaultFor(
      param({ defaultFrom: 'project_aspect_ratio', default: '1:1 (Square)' }),
      { width: 1920, height: 1080 },
      [],
    );
    expect(resolved).toBe('1:1 (Square)');
  });

  it('leaves an ordinary parameter alone', () => {
    expect(defaultFor(param({ default: 20 }), { width: 1920, height: 1080 }, OPTIONS)).toBe(20);
  });

  it('ignores a derivation it does not know, rather than throwing', () => {
    // A manifest written for a later version must not take the panel down; the literal still works.
    expect(isDerivedDefault('project_phase_of_moon')).toBe(false);
    const resolved = defaultFor(
      param({ defaultFrom: 'project_phase_of_moon', default: '4:3 (Standard)' }),
      { width: 1920, height: 1080 },
      OPTIONS,
    );
    expect(resolved).toBe('4:3 (Standard)');
  });
});
