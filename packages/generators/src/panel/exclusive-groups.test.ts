import { describe, expect, it } from 'vitest';
import type { GeneratorManifest, GeneratorParam } from '../contracts/manifest.js';
import {
  type ExclusiveGroup,
  activeMember,
  exclusiveGroupsOf,
  groupLabel,
  isGrouped,
  selectMember,
  unansweredGroups,
} from './exclusive-groups.js';

/**
 * Parameters that are alternatives to one another.
 *
 * `interfaces.md` §2.3: a voice is given either as an enum the backend knows or as a sample to clone,
 * one of the two. Nothing expressed that, so a manifest declaring both rendered two independent
 * controls and a submit carried whichever of them happened to be set — including both.
 */

const voice: GeneratorParam = { key: 'voice', label: 'Voice', type: 'enum', bind: null };
const sample: GeneratorParam = { key: 'voice_reference', label: 'Sample', type: 'audio', bind: null };
const seed: GeneratorParam = { key: 'seed', type: 'seed', bind: null };

function manifest(overrides: Partial<GeneratorManifest> = {}): GeneratorManifest {
  return {
    id: 'tts',
    name: 'TTS',
    backend: 'comfyui',
    produces: 'audio',
    consumes: [],
    surfaces: [],
    requires: [],
    outputs: [],
    params: [voice, sample, seed],
    presets: [],
    ...overrides,
  } as GeneratorManifest;
}

const pair: ExclusiveGroup = { members: ['voice', 'voice_reference'], label: 'Voice', required: true };

describe('the groups a manifest declares', () => {
  it('is nothing when it declares none, so every existing manifest is untouched', () => {
    // Declared rather than inferred: pairing two parameters because they look related would silently
    // group things nobody meant to group.
    expect(exclusiveGroupsOf(manifest())).toEqual([]);
  });

  it('is what it declares', () => {
    const groups = exclusiveGroupsOf(manifest({ exclusive: [pair] }));
    expect(groups[0]?.members).toEqual(['voice', 'voice_reference']);
  });

  it('drops a member the manifest no longer has', () => {
    // A manifest edited to remove a parameter keeps working rather than being rejected.
    const groups = exclusiveGroupsOf(
      manifest({ params: [voice, seed], exclusive: [{ members: ['voice', 'voice_reference', 'seed'] }] }),
    );
    expect(groups[0]?.members).toEqual(['voice', 'seed']);
  });

  it('drops a group left with fewer than two, since that is not a choice', () => {
    expect(
      exclusiveGroupsOf(manifest({ params: [voice, seed], exclusive: [{ members: ['voice', 'gone'] }] })),
    ).toEqual([]);
  });

  it('knows which parameters the chooser draws, so the panel does not draw them twice', () => {
    const groups = exclusiveGroupsOf(manifest({ exclusive: [pair] }));
    expect(isGrouped(groups, voice)).toBe(true);
    expect(isGrouped(groups, seed)).toBe(false);
  });
});

describe('which alternative is in use', () => {
  it('is nothing when none is set — an unanswered group, not an error', () => {
    expect(activeMember(pair, {})).toBeUndefined();
  });

  it('is the one that holds a value', () => {
    expect(activeMember(pair, { voice_reference: 'media/her.wav' })).toBe('voice_reference');
  });

  it('follows declaration order, so a manifest chooses which one a fresh panel opens on', () => {
    expect(activeMember(pair, { voice: 'alto', voice_reference: 'media/her.wav' })).toBe('voice');
  });

  it('does not count a cleared text field as an answer', () => {
    // Otherwise an empty script would satisfy a required group.
    expect(activeMember(pair, { voice: '   ' })).toBeUndefined();
  });

  it('does count a boolean that is deliberately off', () => {
    expect(activeMember({ members: ['a', 'b'] }, { a: false })).toBe('a');
  });
});

describe('choosing one', () => {
  it('removes the others rather than leaving them set', () => {
    // A submit carries whatever the parameters hold: a leftover sample would reach the graph beside
    // the enum the user has since picked, which is the ambiguity the group exists to prevent.
    const next = selectMember(pair, { voice_reference: 'media/her.wav', seed: 7 }, 'voice');
    expect(next).toEqual({ seed: 7 });
  });

  it('leaves everything outside the group alone', () => {
    const next = selectMember(pair, { seed: 7, language: 'hu' }, 'voice');
    expect(next['language']).toBe('hu');
  });
});

describe('refusing a run', () => {
  it('names a required group nobody answered', () => {
    expect(unansweredGroups([pair], {}).map((group) => group.label)).toEqual(['Voice']);
  });

  it('is satisfied by either alternative', () => {
    expect(unansweredGroups([pair], { voice: 'alto' })).toEqual([]);
    expect(unansweredGroups([pair], { voice_reference: 'media/her.wav' })).toEqual([]);
  });

  it('says nothing about an optional group', () => {
    expect(unansweredGroups([{ members: ['a', 'b'] }], {})).toEqual([]);
  });
});

describe('naming the choice', () => {
  it('uses the group´s own label', () => {
    expect(groupLabel(pair, [voice, sample])).toBe('Voice');
  });

  it('falls back to the members´ labels, so an unlabelled group still reads', () => {
    expect(groupLabel({ members: ['voice', 'voice_reference'] }, [voice, sample])).toBe('Voice or Sample');
  });

  it('falls back to the key when a parameter has no label either', () => {
    expect(groupLabel({ members: ['seed', 'voice'] }, [seed, voice])).toBe('seed or Voice');
  });
});
