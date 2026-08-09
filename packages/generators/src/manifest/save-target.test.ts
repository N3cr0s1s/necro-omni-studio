import { describe, expect, it } from 'vitest';
import { freeGeneratorId, manifestFileName, saveTarget } from './save-target.js';

/**
 * What saving an authored manifest would replace.
 *
 * The authoring screen wrote `generators/<id>.manifest.json` with no check, so an id a manifest in the
 * library already had was replaced silently and completely — including the ones that ship with the
 * project.
 */

const library = new Set(['stable_audio_3', 'krea2_img2img', 'krea2_img2img_2']);

describe('where a manifest is written', () => {
  it('is named after its id, which is why two cannot share one', () => {
    expect(manifestFileName('stable_audio_3')).toBe('stable_audio_3.manifest.json');
  });
});

describe('a free id', () => {
  it('leaves one nothing has taken', () => {
    expect(freeGeneratorId('fish_s2', library)).toBe('fish_s2');
  });

  it('suffixes rather than brackets, because an id is an identifier', () => {
    // ` (2)` would be a space and a bracket in something that appears in a filename and in a clip's
    // provenance — a difference every consumer then has to think about.
    expect(freeGeneratorId('stable_audio_3', library)).toBe('stable_audio_3_2');
  });

  it('skips past one that is itself taken', () => {
    expect(freeGeneratorId('krea2_img2img', library)).toBe('krea2_img2img_3');
  });
});

describe('what saving would do', () => {
  it('replaces nothing when the id is new', () => {
    const target = saveTarget('fish_s2', library);
    expect(target).toEqual({ file: 'fish_s2.manifest.json', replaces: undefined, free: undefined });
  });

  it('names what it would replace, and offers a way past it', () => {
    const target = saveTarget('stable_audio_3', library);
    expect(target.replaces).toBe('stable_audio_3');
    expect(target.free).toBe('stable_audio_3_2');
  });

  it('says nothing when the manifest being saved is the one that was opened', () => {
    // Replacing that file is the whole point of reopening it. A warning on every ordinary edit is one
    // that gets learned as noise.
    expect(saveTarget('stable_audio_3', library, 'stable_audio_3').replaces).toBeUndefined();
  });

  it('warns when an opened manifest is renamed onto another', () => {
    // Renaming is authoring a new manifest, and `editing` is the id rather than a boolean so that this
    // case is expressible at all.
    expect(saveTarget('krea2_img2img', library, 'stable_audio_3').replaces).toBe('krea2_img2img');
  });

  it('writes to the path its own naming rule produces', () => {
    // One place for the name, so the check and the write cannot drift.
    expect(saveTarget('anything', library).file).toBe(manifestFileName('anything'));
  });
});
