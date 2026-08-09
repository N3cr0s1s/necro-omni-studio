import { describe, expect, it } from 'vitest';
import {
  capabilitySource,
  choiceMode,
  choicesAsText,
  describeChoices,
  optionsForMode,
  parseChoices,
  toCapabilityOptions,
} from './choices.js';

/**
 * Editing what an enum offers.
 *
 * The logic behind a control that did not exist: the inspector listed `enum` as a parameter type and
 * had no field for its choices, so choosing it produced an error — "an enum needs options" — that
 * nothing on screen could clear, with Save disabled the whole time.
 */

describe('which way the choices come', () => {
  it('is a list for a parameter that has none yet', () => {
    // The shape someone typing a new enum almost always wants, and the other is one click away.
    expect(choiceMode(undefined)).toBe('list');
  });

  it('is a list when there is one, even an empty one', () => {
    expect(choiceMode([])).toBe('list');
    expect(choiceMode(['euler'])).toBe('list');
  });

  it('is the backend when the manifest names a source', () => {
    expect(choiceMode({ from: 'capabilities', nodeClass: 'KSampler', input: 'sampler_name' })).toBe(
      'capabilities',
    );
  });
});

describe('a fixed list', () => {
  it('reads as one editable line', () => {
    expect(choicesAsText(['euler', 'dpmpp_2m'])).toBe('euler, dpmpp_2m');
  });

  it('is empty for a source the backend answers for', () => {
    expect(choicesAsText({ from: 'capabilities' })).toBe('');
  });

  it('comes back from a typed line, trimmed', () => {
    expect(parseChoices(' euler ,dpmpp_2m ')).toEqual(['euler', 'dpmpp_2m']);
  });

  it('drops empty entries rather than keeping them', () => {
    // A trailing comma while typing would otherwise add a choice called nothing — selectable, and
    // submitted to the graph as an empty value.
    expect(parseChoices('euler, , dpmpp_2m,')).toEqual(['euler', 'dpmpp_2m']);
    expect(parseChoices('')).toEqual([]);
    expect(parseChoices('   ')).toEqual([]);
  });

  it('keeps the order and does not merge duplicates', () => {
    // An author who wrote the same value twice has made a mistake worth seeing.
    expect(parseChoices('b, a, b')).toEqual(['b', 'a', 'b']);
  });

  it('survives a round trip through the field', () => {
    expect(parseChoices(choicesAsText(['euler', 'dpmpp_2m', 'ddim']))).toEqual(['euler', 'dpmpp_2m', 'ddim']);
  });
});

describe('a source the backend answers for', () => {
  it('reads out the node class and input', () => {
    expect(capabilitySource({ from: 'capabilities', nodeClass: 'KSampler', input: 'scheduler' })).toEqual({
      nodeClass: 'KSampler',
      input: 'scheduler',
    });
  });

  it('reads blank fields for a source that names nothing yet', () => {
    expect(capabilitySource({ from: 'capabilities' })).toEqual({ nodeClass: '', input: '' });
    expect(capabilitySource(['euler'])).toEqual({ nodeClass: '', input: '' });
  });

  it('omits a blank field rather than writing it empty', () => {
    // Absent asks the backend for whatever it has; `""` names a node class called nothing, which
    // never resolves.
    expect(toCapabilityOptions('', '')).toEqual({ from: 'capabilities' });
    expect(toCapabilityOptions('KSampler', '')).toEqual({ from: 'capabilities', nodeClass: 'KSampler' });
  });

  it('trims what it is given', () => {
    expect(toCapabilityOptions(' KSampler ', ' sampler_name ')).toEqual({
      from: 'capabilities',
      nodeClass: 'KSampler',
      input: 'sampler_name',
    });
  });
});

describe('changing which way they come', () => {
  it('leaves the value alone when the mode has not changed', () => {
    // Otherwise every render would replace a list the user is halfway through typing.
    const list = ['euler'];
    expect(optionsForMode('list', list)).toBe(list);
  });

  it('gives an empty list rather than nothing at all', () => {
    // `undefined` would render as "no choices" with no field to type into, which is the state this
    // whole control exists to remove.
    expect(optionsForMode('list', { from: 'capabilities', nodeClass: 'KSampler' })).toEqual([]);
  });

  it('gives a source with nothing named yet', () => {
    expect(optionsForMode('capabilities', ['euler', 'ddim'])).toEqual({ from: 'capabilities' });
  });
});

describe('what the row says', () => {
  it('counts a list, in words that agree with themselves', () => {
    expect(describeChoices(['a'])).toBe('1 choice');
    expect(describeChoices(['a', 'b'])).toBe('2 choices');
  });

  it('says so when there is nothing yet, either way it is empty', () => {
    expect(describeChoices(undefined)).toBe('no choices yet');
    expect(describeChoices([])).toBe('no choices yet');
  });

  it('names where a backend list comes from', () => {
    // "from the backend" alone leaves someone looking at a wrong list with no way to see which node
    // it came from.
    expect(describeChoices({ from: 'capabilities', nodeClass: 'KSampler', input: 'scheduler' })).toBe(
      'from the backend · KSampler · scheduler',
    );
    expect(describeChoices({ from: 'capabilities' })).toBe('from the backend');
  });
});
