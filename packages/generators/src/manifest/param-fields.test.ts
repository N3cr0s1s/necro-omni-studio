import { describe, expect, it } from 'vitest';
import { PARAM_TYPES } from '../contracts/manifest.js';
import type { ParamField } from './param-fields.js';
import { defaultAsText, defaultControl, fieldsFor, hasField, parseDefault } from './param-fields.js';

/**
 * Which fields a parameter has.
 *
 * Written as data because the inspector had grown four fields out of ten by adding a condition each
 * time one was needed — so the set was never visible anywhere, and the missing six were invisible
 * with it. The most consequential was `transport`: an image parameter authored in the application
 * could not upload its image, which is the whole of what an image parameter does.
 */

const ALL_FIELDS: readonly ParamField[] = [
  'label',
  'min',
  'max',
  'step',
  'default',
  'defaultFrom',
  'options',
  'required',
  'multiline',
  'transport',
];

describe('every parameter type', () => {
  it.each(PARAM_TYPES)('%s is answered for', (type) => {
    // A type added to the list and forgotten here would fall through to the text branch and quietly
    // get the wrong controls. Asserting it is *answered* is what makes the fallback deliberate.
    expect(fieldsFor(type).length).toBeGreaterThan(0);
  });

  it.each(PARAM_TYPES)('%s can be named and made required', (type) => {
    // What a control is called and whether a run can proceed without it are questions about the
    // parameter, never about its value — so they are on everything.
    expect(hasField(type, 'label')).toBe(true);
    expect(hasField(type, 'required')).toBe(true);
  });

  it.each(PARAM_TYPES)('%s claims no field that does not exist', (type) => {
    for (const field of fieldsFor(type)) expect(ALL_FIELDS).toContain(field);
  });

  it.each(PARAM_TYPES)('%s lists each of its fields once', (type) => {
    const fields = fieldsFor(type);
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('what belongs to which type', () => {
  it('gives numbers a range and a step, and nothing else does', () => {
    expect(hasField('int', 'min')).toBe(true);
    expect(hasField('float', 'step')).toBe(true);
    expect(hasField('bool', 'min')).toBe(false);
    expect(hasField('text', 'step')).toBe(false);
  });

  it('gives an asset a transport, which is how it reaches the backend at all', () => {
    // The gap that mattered: without it nothing could author an image parameter that uploads.
    for (const type of ['image', 'video', 'audio', 'mask'] as const) {
      expect(hasField(type, 'transport')).toBe(true);
    }
    expect(hasField('int', 'transport')).toBe(false);
  });

  it('gives an asset no default, because a manifest cannot name a file in someone else’s project', () => {
    expect(hasField('image', 'default')).toBe(false);
    expect(hasField('image', 'defaultFrom')).toBe(false);
  });

  it('gives an enum its choices, and only an enum', () => {
    expect(hasField('enum', 'options')).toBe(true);
    expect(hasField('text', 'options')).toBe(false);
  });

  it('gives text the line-wrapping flag, and only text', () => {
    expect(hasField('text', 'multiline')).toBe(true);
    expect(hasField('int', 'multiline')).toBe(false);
  });

  it('gives a seed no default, because varying is the whole point of one', () => {
    expect(hasField('seed', 'default')).toBe(false);
    expect(defaultControl('seed')).toBe('none');
  });
});

describe('entering a default', () => {
  it('matches the control to the type', () => {
    expect(defaultControl('int')).toBe('number');
    expect(defaultControl('bool')).toBe('boolean');
    expect(defaultControl('enum')).toBe('choice');
    expect(defaultControl('text')).toBe('text');
    expect(defaultControl('image')).toBe('none');
  });

  it('reads a number as a number, not as the text of one', () => {
    // Stored as text the manifest would fail its own schema, and the graph would be patched with a
    // string where the node wants an integer.
    expect(parseDefault('int', '25')).toBe(25);
    expect(parseDefault('float', '0.5')).toBe(0.5);
  });

  it('clears rather than storing a number that will not parse', () => {
    // `NaN` serializes as `null`, which the schema rejects on the way back in — the inspector would
    // write a file it could not reopen.
    expect(parseDefault('int', 'lots')).toBeUndefined();
  });

  it('treats an empty field as no default, which is different from zero', () => {
    // An absent default is omitted from the file and the panel falls back to what the graph holds; a
    // default of 0 overrides it. They must not be the same gesture.
    expect(parseDefault('int', '')).toBeUndefined();
    expect(parseDefault('int', '0')).toBe(0);
    expect(parseDefault('text', '')).toBeUndefined();
  });

  it('reads a boolean from the two words the control offers', () => {
    expect(parseDefault('bool', 'true')).toBe(true);
    expect(parseDefault('bool', 'false')).toBe(false);
  });

  it('refuses to invent a default for a type that has none', () => {
    expect(parseDefault('seed', '4471')).toBeUndefined();
    expect(parseDefault('image', 'media/a.png')).toBeUndefined();
  });

  it('shows a stored default back as text, including a falsy one', () => {
    // `0` and `false` are defaults someone chose. Shown as an empty field they would look unset and be
    // cleared by the next edit.
    expect(defaultAsText(0)).toBe('0');
    expect(defaultAsText(false)).toBe('false');
    expect(defaultAsText(undefined)).toBe('');
  });

  it('survives a round trip through the control', () => {
    for (const [type, value] of [
      ['int', 25],
      ['float', 0.5],
      ['bool', true],
      ['text', 'a drone shot'],
    ] as const) {
      expect(parseDefault(type, defaultAsText(value))).toBe(value);
    }
  });
});
