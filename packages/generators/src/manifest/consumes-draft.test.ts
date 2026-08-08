import { describe, expect, it } from 'vitest';
import type { ConsumesDescriptor } from '../contracts/manifest.js';
import type { DraftParam } from './manifest-draft.js';
import {
  consumedTypeOf,
  editConsumes,
  missingConsumes,
  removeConsumes,
  suggestedConsumes,
  unmatchedConsumes,
} from './consumes-draft.js';

/**
 * What a generator being authored consumes.
 *
 * §5.2 makes this the declaration the framework turns on — the UI derives where an action appears from
 * it — and §5.9 promises the inspector writes manifests without anyone touching code. The field had no
 * control, so everything authored there declared it consumed nothing.
 */

function param(overrides: Partial<DraftParam> = {}): DraftParam {
  return {
    id: 'p1',
    pointer: '/3/inputs/x',
    key: 'script',
    type: 'text',
    ...overrides,
  } as DraftParam;
}

describe('which parameters mean an input', () => {
  it('counts the asset types and text', () => {
    for (const type of ['image', 'video', 'audio', 'mask', 'text'] as const) {
      expect(consumedTypeOf(type)).toBe(type);
    }
  });

  it('does not count a number, a toggle or a seed', () => {
    // A generator taking a `float` does not *consume* anything; treating it as an input would put the
    // action on surfaces that make no sense for it.
    for (const type of ['int', 'float', 'bool', 'enum', 'seed'] as const) {
      expect(consumedTypeOf(type)).toBeUndefined();
    }
  });
});

describe('suggesting inputs from the parameters', () => {
  it('derives one per asset-valued parameter, in declaration order', () => {
    const suggested = suggestedConsumes([
      param({ id: 'a', key: 'script', type: 'text' }),
      param({ id: 'b', key: 'steps', type: 'int' }),
      param({ id: 'c', key: 'voice_reference', type: 'audio' }),
    ]);
    expect(suggested.map((input) => input.role)).toEqual(['script', 'voice_reference']);
    expect(suggested.map((input) => input.type)).toEqual(['text', 'audio']);
  });

  it('defaults the role to the parameter key, which is what binds the two', () => {
    // `inputFor` matches on role, so a suggestion accepted unchanged is already wired rather than
    // merely plausible.
    expect(suggestedConsumes([param({ key: 'first_frame', type: 'image' })])[0]?.role).toBe('first_frame');
  });

  it('offers every text source, so the inspector can author the capable version', () => {
    // Defaulting to `inline` here would mean a manifest written in the inspector could never reach the
    // notes-and-clips binding the spec's §10 describes.
    expect(suggestedConsumes([param({ key: 'script', type: 'text' })])[0]?.sources).toEqual([
      'inline',
      'notes_file',
      'text_clip',
    ]);
  });

  it('gives sources to text alone', () => {
    expect(suggestedConsumes([param({ key: 'voice', type: 'audio' })])[0]?.sources).toBeUndefined();
  });

  it('carries whether the parameter was required', () => {
    expect(suggestedConsumes([param({ key: 'script', required: true })])[0]?.required).toBe(true);
  });
});

describe('re-deriving without duplicating', () => {
  it('offers only what is not declared yet', () => {
    const declared: readonly ConsumesDescriptor[] = [{ type: 'text', role: 'script' }];
    const suggested = suggestedConsumes([
      param({ id: 'a', key: 'script', type: 'text' }),
      param({ id: 'b', key: 'voice_reference', type: 'audio' }),
    ]);
    expect(missingConsumes(declared, suggested).map((input) => input.role)).toEqual(['voice_reference']);
  });

  it('tells two inputs of the same type apart by their role', () => {
    // Two images are distinguished by being `first_frame` and `style_reference` and by nothing else.
    const declared: readonly ConsumesDescriptor[] = [{ type: 'image', role: 'first_frame' }];
    const suggested = suggestedConsumes([
      param({ id: 'a', key: 'first_frame', type: 'image' }),
      param({ id: 'b', key: 'style_reference', type: 'image' }),
    ]);
    expect(missingConsumes(declared, suggested).map((input) => input.role)).toEqual(['style_reference']);
  });
});

describe('editing a declared input', () => {
  const inputs: readonly ConsumesDescriptor[] = [
    { type: 'text', role: 'script', sources: ['inline'] },
    { type: 'audio', role: 'voice' },
  ];

  it('changes one and leaves the rest alone', () => {
    const edited = editConsumes(inputs, 0, { role: 'narration' });
    expect(edited[0]?.role).toBe('narration');
    expect(edited[1]).toEqual(inputs[1]);
  });

  it('leaves a field the change did not mention', () => {
    // The codebase's change-object rule: `undefined` means leave it, not clear it.
    expect(editConsumes(inputs, 0, { required: true })[0]?.sources).toEqual(['inline']);
  });

  it('refuses to blank a role, which would unbind the input from its parameter', () => {
    expect(editConsumes(inputs, 0, { role: '   ' })[0]?.role).toBe('script');
  });

  it('writes sources onto text and nowhere else', () => {
    // On an image input they would be a field every reader ignores and the next author has to explain.
    expect(editConsumes(inputs, 1, { sources: ['notes_file'] })[1]?.sources).toBeUndefined();
    expect(editConsumes(inputs, 0, { sources: ['notes_file'] })[0]?.sources).toEqual(['notes_file']);
  });
});

describe('removing an input', () => {
  it('drops exactly the one asked for', () => {
    const inputs: readonly ConsumesDescriptor[] = [
      { type: 'text', role: 'a' },
      { type: 'audio', role: 'b' },
    ];
    expect(removeConsumes(inputs, 0).map((input) => input.role)).toEqual(['b']);
  });
});

describe('inputs with nothing to fill them', () => {
  it('names one whose role matches no parameter', () => {
    // Not corrected: a manifest may describe what it consumes before its parameters exist. But it is
    // worth saying, because the surfaces get derived from something the panel cannot ask for.
    const unmatched = unmatchedConsumes(
      [
        { type: 'text', role: 'script' },
        { type: 'audio', role: 'voice' },
      ],
      [param({ key: 'script', type: 'text' })],
    );
    expect(unmatched.map((input) => input.role)).toEqual(['voice']);
  });

  it('counts one with no role at all, since nothing can match it', () => {
    expect(unmatchedConsumes([{ type: 'text' }], [param({ key: 'script' })])).toHaveLength(1);
  });
});
