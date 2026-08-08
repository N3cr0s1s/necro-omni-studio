import { describe, expect, it } from 'vitest';
import {
  childPath,
  formatIssues,
  vArray,
  vBoolean,
  vEnum,
  vFallback,
  vInteger,
  vLiteral,
  vMap,
  vNonEmptyString,
  vNumber,
  vObject,
  vOptional,
  vPositiveInteger,
  vRecord,
  vRefine,
  vString,
  vTagged,
  vTryMap,
  vWithDefault,
  validate,
} from './validate.js';

describe('primitives', () => {
  it('accepts matching types', () => {
    expect(validate(vString, 'a')).toEqual({ ok: true, value: 'a' });
    expect(validate(vNumber, 1.5)).toEqual({ ok: true, value: 1.5 });
    expect(validate(vBoolean, false)).toEqual({ ok: true, value: false });
    expect(validate(vInteger, 3)).toEqual({ ok: true, value: 3 });
  });

  it('names the received type in the message', () => {
    const result = validate(vString, 42);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.message).toBe('expected string, got number');
  });

  it('distinguishes null and array from object', () => {
    const shape = vObject({ a: vString });
    for (const [input, expected] of [
      [null, 'expected object, got null'],
      [[], 'expected object, got array'],
    ] as const) {
      const result = validate(shape, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error[0]!.message).toBe(expected);
    }
  });

  it('rejects NaN and Infinity, which poison downstream arithmetic silently', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const result = validate(vNumber, value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error[0]!.message).toContain('finite');
    }
  });

  it('rejects a non-integer where an integer is required', () => {
    const result = validate(vInteger, 1.5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.message).toContain('integer');
  });

  it('checks literals and enums, listing the alternatives', () => {
    expect(validate(vLiteral('video'), 'video')).toEqual({ ok: true, value: 'video' });
    const result = validate(vEnum(['linear', 'hold']), 'bezier');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.message).toBe('expected one of linear | hold, got "bezier"');
  });
});

describe('paths', () => {
  it('builds dotted and indexed paths', () => {
    expect(childPath('', 'a')).toBe('a');
    expect(childPath('a', 'b')).toBe('a.b');
    expect(childPath('a.b', 0)).toBe('a.b[0]');
  });

  it('reports the full path to a nested failure', () => {
    const validator = vObject({
      sequence: vObject({ tracks: vArray(vObject({ name: vString })) }),
    });
    const result = validate(validator, { sequence: { tracks: [{ name: 'V1' }, { name: 7 }] } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.path).toBe('sequence.tracks[1].name');
  });
});

describe('accumulation', () => {
  it('reports every bad field in an object, not just the first', () => {
    const validator = vObject({ a: vString, b: vNumber, c: vBoolean });
    const result = validate(validator, { a: 1, b: 'x', c: 'y' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toHaveLength(3);
      expect(result.error.map((entry) => entry.path)).toEqual(['a', 'b', 'c']);
    }
  });

  it('reports every bad element in an array', () => {
    const result = validate(vArray(vNumber), [1, 'x', 3, 'y']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.map((entry) => entry.path)).toEqual(['[1]', '[3]']);
    }
  });

  it('accumulates across nesting levels at once', () => {
    const validator = vObject({ items: vArray(vObject({ id: vString, size: vNumber })) });
    const result = validate(validator, { items: [{ id: 1, size: 'a' }, { id: 'ok', size: 2 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toHaveLength(2);
  });
});

describe('optionality', () => {
  it('treats undefined and null as absent', () => {
    const validator = vObject({ a: vOptional(vString) });
    expect(validate(validator, {})).toEqual({ ok: true, value: {} });
    expect(validate(validator, { a: null })).toEqual({ ok: true, value: {} });
  });

  it('omits the key entirely rather than setting it to undefined', () => {
    const result = validate(vObject({ a: vOptional(vString) }), {});
    expect(result.ok).toBe(true);
    if (result.ok) expect('a' in result.value).toBe(false);
  });

  it('still validates a present optional value', () => {
    const result = validate(vObject({ a: vOptional(vString) }), { a: 5 });
    expect(result.ok).toBe(false);
  });

  it('substitutes a default when absent', () => {
    const validator = vObject({ gain: vWithDefault(vNumber, 1) });
    expect(validate(validator, {})).toEqual({ ok: true, value: { gain: 1 } });
    expect(validate(validator, { gain: 0.5 })).toEqual({ ok: true, value: { gain: 0.5 } });
  });

  it('still rejects a present but invalid value under vWithDefault', () => {
    // The distinction from vFallback: a typo must not be silently swallowed, because the
    // next save would write the substituted value and lose what the user meant.
    expect(validate(vObject({ gain: vWithDefault(vNumber, 1) }), { gain: 'loud' }).ok).toBe(false);
  });
});

describe('vFallback', () => {
  it('substitutes the default for an absent value', () => {
    expect(validate(vFallback(vEnum(['linear', 'hold']), 'linear'), undefined)).toEqual({
      ok: true,
      value: 'linear',
    });
  });

  it('substitutes the default for an unrecognized member of a closed vocabulary', () => {
    // A project written by a build with Bezier easing must still open, showing that one
    // segment straight rather than refusing the whole timeline.
    expect(validate(vFallback(vEnum(['linear', 'hold']), 'linear'), 'bezier')).toEqual({
      ok: true,
      value: 'linear',
    });
  });

  it('substitutes the default for a wholly wrong type', () => {
    expect(validate(vFallback(vEnum(['linear']), 'linear'), { nested: true })).toEqual({
      ok: true,
      value: 'linear',
    });
  });

  it('keeps a valid value', () => {
    expect(validate(vFallback(vEnum(['linear', 'hold']), 'linear'), 'hold')).toEqual({
      ok: true,
      value: 'hold',
    });
  });
});

describe('forward compatibility', () => {
  it('ignores unknown keys, so a newer project still opens in an older build', () => {
    const validator = vObject({ a: vString });
    const result = validate(validator, { a: 'x', futureField: { nested: true } });
    expect(result).toEqual({ ok: true, value: { a: 'x' } });
  });
});

describe('vTagged', () => {
  type TestClip =
    | { readonly kind: 'video'; readonly asset: string }
    | { readonly kind: 'text'; readonly content: string };

  // The union must be named explicitly: inference would otherwise fix `T` to the first
  // variant and reject the rest.
  const clip = vTagged<TestClip>('kind', {
    video: vObject<{ kind: 'video'; asset: string }>({ kind: vLiteral('video'), asset: vString }),
    text: vObject<{ kind: 'text'; content: string }>({
      kind: vLiteral('text'),
      content: vString,
    }),
  });

  it('dispatches to the matching variant', () => {
    expect(validate(clip, { kind: 'text', content: 'TITLE' })).toEqual({
      ok: true,
      value: { kind: 'text', content: 'TITLE' },
    });
  });

  it('reports an unknown tag against the discriminant, not as every variant failing', () => {
    const result = validate(clip, { kind: 'audio' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toHaveLength(1);
      expect(result.error[0]!.path).toBe('kind');
      expect(result.error[0]!.message).toContain('unknown kind "audio"');
    }
  });

  it('reports a missing discriminant', () => {
    const result = validate(clip, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.path).toBe('kind');
  });

  it('validates the selected variant', () => {
    const result = validate(clip, { kind: 'video', asset: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.path).toBe('asset');
  });
});

describe('vRecord', () => {
  it('validates a string-keyed map', () => {
    expect(validate(vRecord(vNumber), { a: 1, b: 2 })).toEqual({
      ok: true,
      value: { a: 1, b: 2 },
    });
  });

  it('paths into the offending key', () => {
    const result = validate(vRecord(vNumber), { amount: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.path).toBe('amount');
  });
});

describe('transformation', () => {
  it('maps a validated value', () => {
    expect(validate(vMap(vString, (value) => value.length), 'abcd')).toEqual({
      ok: true,
      value: 4,
    });
  });

  it('turns a throwing factory into a validation issue', () => {
    const validator = vTryMap(vString, (value) => {
      if (value.includes('..')) throw new Error('must not escape the project folder');
      return value;
    });
    const result = validate(validator, '../secrets');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.message).toBe('must not escape the project folder');
  });

  it('does not run the transform when validation already failed', () => {
    let ran = false;
    const validator = vTryMap(vString, (value) => {
      ran = true;
      return value;
    });
    validate(validator, 5);
    expect(ran).toBe(false);
  });
});

describe('refinements', () => {
  it('rejects an empty string with a labelled message', () => {
    const result = validate(vNonEmptyString('name'), '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]!.message).toBe('name must not be empty');
  });

  it('enforces positivity', () => {
    expect(validate(vPositiveInteger('width'), 0).ok).toBe(false);
    expect(validate(vPositiveInteger('width'), 1920).ok).toBe(true);
  });

  it('supports a custom predicate', () => {
    const even = vRefine(vInteger, (value) => value % 2 === 0, 'expected an even number');
    expect(validate(even, 3).ok).toBe(false);
    expect(validate(even, 4).ok).toBe(true);
  });
});

describe('formatIssues', () => {
  it('renders one line per issue, labelling the root', () => {
    const result = validate(vObject({ a: vString, b: vNumber }), { a: 1, b: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(formatIssues(result.error)).toBe(
        'a: expected string, got number\nb: expected number, got string',
      );
    }
  });

  it('labels a root-level issue', () => {
    const result = validate(vString, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(formatIssues(result.error)).toBe('<root>: expected string, got number');
  });
});
