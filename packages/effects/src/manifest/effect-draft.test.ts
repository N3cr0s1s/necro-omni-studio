import { describe, expect, it } from 'vitest';
import { validate } from '@nos/core';
import { normalizeManifestKeys, vAnyEffectManifest } from './effect-manifest.js';

/** The manifest as the registry reads it — the same two calls, so this cannot pass a file the app rejects. */
const parseEffectManifest = (json: unknown) => validate(vAnyEffectManifest, normalizeManifestKeys(json));
import {
  type EffectDraft,
  STARTER_SHADER,
  draftFromEffect,
  effectDraftHasErrors,
  effectFiles,
  effectManifestJson,
  emptyEffectDraft,
  uniformOf,
  validateEffectDraft,
} from './effect-draft.js';

/**
 * Authoring an effect.
 *
 * Issue #28. §6.3 has always defined an effect as a GLSL file plus a manifest, and §4 has always
 * reserved `effects/` for both — so the format existed and the only way in was a text editor and a
 * reload.
 */

const usable = (overrides: Partial<EffectDraft> = {}): EffectDraft =>
  emptyEffectDraft({ id: 'my_effect', name: 'My effect', ...overrides });

describe('the two files an effect is', () => {
  it('are both named from the id, so a check and a write cannot drift', () => {
    expect(effectFiles('film_grain')).toEqual({
      manifest: 'film_grain.json',
      shader: 'film_grain.frag',
    });
  });
});

describe('a new effect', () => {
  it('starts from a shader that compiles and renders the frame unchanged', () => {
    // An editor that opens on an empty box gives a compile error before anything is typed, which
    // teaches the user the tool is broken.
    expect(STARTER_SHADER).toContain('void main');
    expect(STARTER_SHADER).toContain('fragColor');
    expect(validateEffectDraft(usable()).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('reads the frame, so `source` is declared and used from the start', () => {
    expect(usable().samplers).toEqual(['source']);
    expect(validateEffectDraft(usable()).some((issue) => /never reads "source"/.test(issue.message))).toBe(
      false,
    );
  });
});

describe('the manifest it writes', () => {
  it('names the shader beside it', () => {
    expect(effectManifestJson(usable())['shader']).toBe('my_effect.frag');
  });

  it('leaves out a uniform that matches its key, which is the common case', () => {
    const draft = usable({
      params: [{ id: 'a', key: 'amount', uniform: '', type: 'float' }],
      shader: 'void main(){ fragColor = vec4(amount); }',
    });
    const [param] = effectManifestJson(draft)['params'] as readonly Record<string, unknown>[];
    expect(param).not.toHaveProperty('uniform');
    expect(param).toMatchObject({ key: 'amount', type: 'float' });
  });

  it('writes a uniform that differs', () => {
    const draft = usable({
      params: [{ id: 'a', key: 'amount', uniform: 'u_amount', type: 'float' }],
      shader: 'void main(){ fragColor = vec4(u_amount); }',
    });
    const [param] = effectManifestJson(draft)['params'] as readonly Record<string, unknown>[];
    expect(param).toMatchObject({ uniform: 'u_amount' });
  });

  it('omits `keyframable`, which the schema derives from the type', () => {
    // Writing it out puts a field in every file that can disagree with the rule it restates.
    const draft = usable({
      params: [{ id: 'a', key: 'amount', uniform: '', type: 'float' }],
      shader: 'void main(){ fragColor = vec4(amount); }',
    });
    expect((effectManifestJson(draft)['params'] as readonly Record<string, unknown>[])[0]).not.toHaveProperty(
      'keyframable',
    );
  });

  it('is accepted by the schema that reads it back', () => {
    // The claim the whole editor rests on: what it writes is a manifest the registry will load.
    const draft = usable({
      group: 'Colour',
      params: [{ id: 'a', key: 'amount', uniform: '', type: 'float', min: 0, max: 1, default: 0.5 }],
      shader: 'void main(){ fragColor = vec4(amount); }',
    });
    const parsed = parseEffectManifest({ ...effectManifestJson(draft), shaderSource: draft.shader });
    expect(parsed.ok).toBe(true);
  });
});

describe('reopening one', () => {
  it('comes back the same, so editing does not degrade a file', () => {
    const draft = usable({
      group: 'Colour',
      description: 'Tints the frame',
      params: [{ id: 'a', key: 'amount', uniform: 'u_amount', type: 'float', min: 0, max: 1 }],
      shader: 'void main(){ fragColor = vec4(u_amount); }',
    });
    const parsed = parseEffectManifest({ ...effectManifestJson(draft), shaderSource: draft.shader });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const reopened = draftFromEffect(parsed.value, draft.shader);
    expect(effectManifestJson(reopened)).toEqual(effectManifestJson(draft));
  });

  it('shows an omitted uniform as omitted, not as the value the schema filled in', () => {
    // Otherwise the field looks edited when it was not, and saving would write it out.
    const draft = usable({
      params: [{ id: 'a', key: 'amount', uniform: '', type: 'float' }],
      shader: 'void main(){ fragColor = vec4(amount); }',
    });
    const parsed = parseEffectManifest({ ...effectManifestJson(draft), shaderSource: draft.shader });
    if (!parsed.ok) throw new Error('fixture does not parse');
    expect(draftFromEffect(parsed.value, draft.shader).params[0]?.uniform).toBe('');
  });
});

describe('what is wrong with it', () => {
  const errors = (draft: EffectDraft) =>
    validateEffectDraft(draft)
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${issue.path}: ${issue.message}`);

  it('refuses an id that could not be a filename', () => {
    // The id becomes two filenames and appears in `EffectInstance.effect`.
    expect(errors(usable({ id: 'my effect' }))[0]).toContain('/id');
    expect(errors(usable({ id: '2fast' }))[0]).toContain('/id');
    expect(errors(usable({ id: '' }))[0]).toContain('an id is required');
  });

  it('refuses a shader with no main', () => {
    expect(errors(usable({ shader: 'vec4 x;' })).join(' ')).toContain('main()');
  });

  it('refuses a shader that writes nothing out', () => {
    // It compiles and renders nothing, and the compile error is about an unused output — which is not
    // what the author needs to be told.
    const silent = usable({ shader: 'void main(){ vec4 c = texture(source, v_uv); }' });
    expect(errors(silent).join(' ')).toContain('fragColor');
  });

  it('refuses two parameters bound to one uniform', () => {
    // One value silently wins, which looks like a control that does nothing.
    const clash = usable({
      params: [
        { id: 'a', key: 'a', uniform: 'amount', type: 'float' },
        { id: 'b', key: 'b', uniform: 'amount', type: 'float' },
      ],
      shader: 'void main(){ fragColor = vec4(amount); }',
    });
    expect(errors(clash).join(' ')).toContain('both bind');
  });

  it('refuses a range the wrong way round', () => {
    const wrong = usable({
      params: [{ id: 'a', key: 'a', uniform: '', type: 'float', min: 1, max: 0 }],
      shader: 'void main(){ fragColor = vec4(a); }',
    });
    expect(errors(wrong).join(' ')).toContain('minimum is above the maximum');
  });

  it('warns, and does not block, when the shader never reads a declared parameter', () => {
    // The control appears and does nothing — worth hearing, but the next keystroke may fix it.
    const unread = usable({
      params: [{ id: 'a', key: 'amount', uniform: '', type: 'float' }],
    });
    const issues = validateEffectDraft(unread);
    expect(issues.some((i) => i.severity === 'warning' && /never reads "amount"/.test(i.message))).toBe(true);
    expect(effectDraftHasErrors(unread)).toBe(false);
  });

  it('is not fooled by a mention in a comment', () => {
    // The starter shader documents `source` and `fragColor` in its header; a check that counted those
    // would call every unfinished effect complete.
    const commented = usable({
      params: [{ id: 'a', key: 'amount', uniform: '', type: 'float' }],
      shader: '// amount is not used yet\nvoid main(){ fragColor = texture(source, v_uv); }',
    });
    expect(validateEffectDraft(commented).some((i) => /never reads "amount"/.test(i.message))).toBe(true);
  });

  it('does not accept a partial word as a use', () => {
    // `blur` must not be satisfied by `blur_radius`, or a parameter reads as used when it is not.
    const partial = usable({
      params: [{ id: 'a', key: 'blur', uniform: '', type: 'float' }],
      shader: 'void main(){ fragColor = vec4(blur_radius); }',
    });
    expect(validateEffectDraft(partial).some((i) => /never reads "blur"/.test(i.message))).toBe(true);
  });

  it('says nothing about a draft that is finished', () => {
    const good = usable({
      params: [{ id: 'a', key: 'amount', uniform: '', type: 'float', min: 0, max: 1, default: 0.5 }],
      shader: 'void main(){ fragColor = texture(source, v_uv) * amount; }',
    });
    expect(validateEffectDraft(good)).toEqual([]);
  });
});

describe('the uniform a parameter binds', () => {
  it('is what was typed', () => {
    expect(uniformOf({ id: 'a', key: 'amount', uniform: 'u_amount', type: 'float' })).toBe('u_amount');
  });

  it('falls back to the key when nothing was typed', () => {
    expect(uniformOf({ id: 'a', key: 'amount', uniform: '  ', type: 'float' })).toBe('amount');
  });
});
