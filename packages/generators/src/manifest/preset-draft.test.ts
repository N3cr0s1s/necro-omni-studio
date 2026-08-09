import { describe, expect, it } from 'vitest';
import { presetId } from '@nos/core';
import type { GeneratorPreset } from '../contracts/manifest.js';
import type { DraftParam, ManifestDraft } from './manifest-draft.js';
import { emptyDraft } from './manifest-draft.js';
import {
  addPreset,
  editPreset,
  parsePresetValue,
  presetIssues,
  removePreset,
  roleOf,
  setRole,
  setValue,
  valueIn,
} from './preset-draft.js';

/**
 * Authoring presets.
 *
 * The inspector could not: `presets` appeared nowhere in the panel, so a generator written inside the
 * application had none and no way to get any — while two of the shipped manifests carry six between
 * them.
 */

const preset = (over: Partial<GeneratorPreset> = {}): GeneratorPreset => ({
  id: presetId('sfx'),
  name: 'SFX',
  pin: { category: 'SFX' },
  set: { duration_s: 5 },
  ...over,
});

const param = (key: string, type: DraftParam['type'] = 'text'): DraftParam => ({
  id: key,
  pointer: `/1/inputs/${key}`,
  key,
  type,
});

const draftWith = (presets: readonly GeneratorPreset[], params: readonly DraftParam[] = []) =>
  ({ ...emptyDraft(), presets, params }) as ManifestDraft;

describe('what a preset says about a parameter', () => {
  it('is pinned when the preset fixes it', () => {
    expect(roleOf(preset(), 'category')).toBe('pinned');
  });

  it('is pre-filled when the preset only suggests it', () => {
    expect(roleOf(preset(), 'duration_s')).toBe('prefilled');
  });

  it('is free when the preset does not mention it', () => {
    expect(roleOf(preset(), 'seed')).toBe('free');
  });

  it('reads the value whichever way it is given', () => {
    expect(valueIn(preset(), 'category')).toBe('SFX');
    expect(valueIn(preset(), 'duration_s')).toBe(5);
    expect(valueIn(preset(), 'seed')).toBeUndefined();
  });
});

describe('changing what it says', () => {
  it('carries the value across a change of role', () => {
    // Changing your mind about whether a value is fixed or suggested should not make you type it
    // again.
    const loosened = setRole(preset(), 'category', 'prefilled');
    expect(loosened.set?.['category']).toBe('SFX');
    expect(loosened.pin['category']).toBeUndefined();
  });

  it('never leaves a parameter in both records at once', () => {
    // The format has no meaning for a key that is both fixed and merely suggested.
    const moved = setRole(preset(), 'duration_s', 'pinned');
    expect(moved.pin['duration_s']).toBe(5);
    expect(moved.set?.['duration_s']).toBeUndefined();
  });

  it('drops the value when the preset stops mentioning it', () => {
    // The only honest reading of "this preset says nothing about this parameter".
    const freed = setRole(preset(), 'category', 'free');
    expect(roleOf(freed, 'category')).toBe('free');
    expect(valueIn(freed, 'category')).toBeUndefined();
  });

  it('takes a value for a parameter it had not mentioned', () => {
    const added = setRole(preset(), 'seed', 'prefilled', 42);
    expect(valueIn(added, 'seed')).toBe(42);
  });

  it('gives a pinned parameter with no value an empty one rather than an absent key', () => {
    // A pin with no value is meaningless — the value is what constitutes the preset — and an absent
    // key would silently read back as `free`.
    const pinned = setRole(preset(), 'seed', 'pinned');
    expect(roleOf(pinned, 'seed')).toBe('pinned');
    expect(pinned.pin['seed']).toBe('');
  });

  it('drops an empty set rather than writing one', () => {
    // The format omits it, and an empty object in the file is a line every reader has to skip.
    const emptied = setRole(preset(), 'duration_s', 'free');
    expect(emptied.set).toBeUndefined();
  });

  it('changes a value without changing which record it is in', () => {
    expect(setValue(preset(), 'category', 'Music').pin['category']).toBe('Music');
    expect(setValue(preset(), 'duration_s', 9).set?.['duration_s']).toBe(9);
  });

  it('ignores a value for a parameter the preset does not mention', () => {
    // Otherwise a stray edit would silently add a key, and the role control would jump under the
    // user's hand.
    expect(setValue(preset(), 'seed', 1)).toEqual(preset());
  });
});

describe('typing a value', () => {
  it('uses the parameter’s own type, exactly as a default does', () => {
    // A preset value is patched into the graph like a default, so text where a number belongs fails
    // in the same place and for the same reason.
    expect(parsePresetValue(param('duration_s', 'float'), '2.5')).toBe(2.5);
    expect(parsePresetValue(param('loop', 'bool'), 'true')).toBe(true);
    expect(parsePresetValue(param('category'), 'SFX')).toBe('SFX');
  });
});

describe('the list of presets', () => {
  it('adds one that is distinguishable before it is renamed', () => {
    const added = addPreset(draftWith([]));
    expect(added.presets).toHaveLength(1);
    expect(added.presets[0]?.name).toBe('Preset 1');
  });

  it('never reuses an id that is still taken', () => {
    // Ids address a preset in a clip's provenance; two sharing one is a recall that loads the wrong
    // settings.
    const draft = draftWith([preset({ id: presetId('preset_1') }), preset({ id: presetId('preset_3') })]);
    const added = addPreset(draft);
    expect(new Set(added.presets.map((entry) => entry.id)).size).toBe(3);
  });

  it('removes the one named and no other', () => {
    const draft = draftWith([preset({ id: presetId('a') }), preset({ id: presetId('b') })]);
    expect(removePreset(draft, presetId('a')).presets.map((entry) => entry.id)).toEqual(['b']);
  });

  it('replaces one in place, keeping the order', () => {
    const draft = draftWith([preset({ id: presetId('a') }), preset({ id: presetId('b') })]);
    const edited = editPreset(draft, presetId('a'), preset({ id: presetId('a'), name: 'Renamed' }));
    expect(edited.presets.map((entry) => entry.name)).toEqual(['Renamed', 'SFX']);
  });
});

describe('what is wrong with them', () => {
  it('says nothing about a draft that is fine', () => {
    const draft = draftWith([preset()], [param('category'), param('duration_s', 'float')]);
    expect(presetIssues(draft)).toEqual([]);
  });

  it('names a parameter a preset refers to that no longer exists', () => {
    // Reported rather than silently dropped: a renamed parameter is an ordinary consequence of
    // editing, and dropping the entry would lose a value the author meant to keep.
    const draft = draftWith([preset()], [param('category')]);
    expect(presetIssues(draft).map((issue) => issue.message)).toEqual([
      'names a parameter that does not exist: "duration_s"',
    ]);
  });

  it('catches two presets claiming one id', () => {
    const draft = draftWith([preset(), preset()], [param('category'), param('duration_s', 'float')]);
    expect(presetIssues(draft).some((issue) => issue.message.includes('duplicate'))).toBe(true);
  });

  it('catches a preset with no name, which would draw as an empty button', () => {
    const draft = draftWith([preset({ name: '  ' })], [param('category'), param('duration_s', 'float')]);
    expect(presetIssues(draft).some((issue) => issue.message.includes('needs a name'))).toBe(true);
  });
});
