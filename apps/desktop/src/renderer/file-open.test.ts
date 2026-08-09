import { describe, expect, it } from 'vitest';
import { SOURCE_KINDS, actionFor, effectForShader, extensionOf } from './file-open.js';

/**
 * What opening a file in the browser should do.
 *
 * Issue #32: double-clicking a `.frag` said "…is not something that can go on the timeline" — true,
 * and useless. A shader is not timeline material and is very much something this application can
 * open.
 */

describe('the extension', () => {
  it('is the last one, lowercased', () => {
    expect(extensionOf('effects/Film_Grain.FRAG')).toBe('.frag');
  });

  it('is nothing for a file that has none', () => {
    expect(extensionOf('notes/README')).toBe('');
  });

  it('is nothing for a dotfile, which has a name and not an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
  });

  it('is not fooled by a dot in a folder name', () => {
    expect(extensionOf('my.effects/grain')).toBe('');
  });
});

describe('media', () => {
  it.each(['media/a.mp4', 'media/a.wav', 'generated/a.flac', 'media/a.png'])(
    '%s goes to the timeline',
    (path) => {
      expect(actionFor(path)).toEqual({ kind: 'timeline' });
    },
  );

  it('wins over anything else, because that is what the browser is mostly for', () => {
    // A `.png` used as a generator input is still a picture.
    expect(actionFor('media/frame.png').kind).toBe('timeline');
  });
});

describe('sources', () => {
  it('opens a shader in the effect editor', () => {
    expect(actionFor('effects/film_grain.frag')).toEqual({
      kind: 'tab',
      tab: 'effect',
      subject: 'effects/film_grain.frag',
    });
  });

  it('opens a manifest, a note and a plain file in the text editor', () => {
    for (const path of ['generators/x.manifest.json', 'notes/a.md', 'notes/a.txt']) {
      expect(actionFor(path)).toMatchObject({ kind: 'tab', tab: 'text', subject: path });
    }
  });

  it('claims each extension exactly once', () => {
    // Two kinds claiming `.json` would make which editor opens depend on table order, silently.
    const all = SOURCE_KINDS.flatMap((kind) => kind.extensions);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('anything else', () => {
  it('says what it cannot do rather than what the file is not', () => {
    // "is not something that can go on the timeline" is what the user was told, and it left them with
    // nowhere to go.
    const action = actionFor('cache/thing.bin');
    expect(action.kind).toBe('none');
    if (action.kind !== 'none') return;
    expect(action.reason).toContain('.bin');
  });

  it('says something useful about a file with no extension at all', () => {
    const action = actionFor('notes/README');
    expect(action.kind).toBe('none');
    if (action.kind !== 'none') return;
    expect(action.reason).toContain('no extension');
  });
});

describe('the effect a shader belongs to', () => {
  const manifests = [
    { id: 'film_grain', shader: 'film_grain.frag' },
    { id: 'tint', shader: 'tint.frag' },
  ];

  it('is the one whose manifest names it', () => {
    expect(effectForShader('effects/tint.frag', manifests)).toBe('tint');
  });

  it('is matched by what the manifest names, not by the filename convention', () => {
    // A manifest is free to name any shader beside it, and `<id>.frag` is only the editor's default.
    expect(effectForShader('effects/grain.frag', [{ id: 'film_grain', shader: 'grain.frag' }])).toBe(
      'film_grain',
    );
  });

  it('is nothing for a shader no manifest claims', () => {
    // An orphan shader is a real thing to have while one is being written, and not an error.
    expect(effectForShader('effects/scratch.frag', manifests)).toBeUndefined();
  });
});
