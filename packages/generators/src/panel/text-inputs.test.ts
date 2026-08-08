import { describe, expect, it } from 'vitest';
import type { GeneratorManifest, GeneratorParam } from '../contracts/manifest.js';
import {
  type TextChoice,
  choicesForSource,
  hasAlternativeSources,
  inputFor,
  previewOf,
  textSourcesFor,
} from './text-inputs.js';

/**
 * Where a text parameter's value may come from.
 *
 * The spec's §10 allows a text-to-speech script to be typed, taken from a `notes/` file, or taken from
 * a text clip already on the timeline. All three were declared in the manifest contract and parsed —
 * and read by nothing, so a script that was already written had to be typed out again.
 */

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
    params: [],
    presets: [],
    ...overrides,
  } as GeneratorManifest;
}

const script: GeneratorParam = { key: 'script', type: 'text', bind: '/3/inputs/text' };

describe('the sources a text input declares', () => {
  it('is typing it when the manifest says nothing', () => {
    // Not "all of them": a manifest that declares no sources is asking for a value, and offering to
    // bind it to a timeline clip would invent an intention its author never expressed.
    expect(textSourcesFor(undefined)).toEqual(['inline']);
    expect(textSourcesFor({ type: 'text', role: 'script' })).toEqual(['inline']);
  });

  it('is what the manifest declares, in its own order', () => {
    expect(
      textSourcesFor({ type: 'text', role: 'script', sources: ['inline', 'notes_file', 'text_clip'] }),
    ).toEqual(['inline', 'notes_file', 'text_clip']);
  });

  it('drops a source this build has never heard of rather than refusing the manifest', () => {
    // The same forward-compatibility rule the registry applies to unknown node classes: a manifest
    // written against a later build still works here for the sources this one understands.
    expect(
      textSourcesFor({ type: 'text', role: 'script', sources: ['notes_file', 'caption_track'] }),
    ).toEqual(['notes_file']);
  });

  it('never comes back empty, because typing always works', () => {
    expect(textSourcesFor({ type: 'text', role: 'script', sources: ['caption_track'] })).toEqual(['inline']);
  });
});

describe('matching a parameter to what it consumes', () => {
  it('matches on the role, which is the only thing tying the two together', () => {
    const found = inputFor(
      manifest({
        consumes: [
          { type: 'audio', role: 'voice_reference' },
          { type: 'text', role: 'script', sources: ['notes_file'] },
        ],
      }),
      script,
    );
    expect(found?.sources).toEqual(['notes_file']);
  });

  it('falls back to the one text input when the manifest gave no role', () => {
    // A manifest that omitted the role should keep working rather than silently losing its sources.
    const found = inputFor(manifest({ consumes: [{ type: 'text', sources: ['text_clip'] }] }), script);
    expect(found?.sources).toEqual(['text_clip']);
  });

  it('finds nothing for a parameter with no matching input', () => {
    expect(inputFor(manifest({ consumes: [{ type: 'audio', role: 'voice' }] }), script)).toBeUndefined();
  });
});

describe('offering the choices', () => {
  const choices: readonly TextChoice[] = [
    { source: 'notes_file', ref: 'notes/a.md', label: 'a.md', preview: 'Once upon' },
    { source: 'text_clip', ref: 'clip_1', label: 'Title', preview: 'Hello' },
    { source: 'notes_file', ref: 'notes/b.md', label: 'b.md', preview: '' },
  ];

  it('shows files or clips, never both at once', () => {
    expect(choicesForSource(choices, 'notes_file').map((choice) => choice.ref)).toEqual([
      'notes/a.md',
      'notes/b.md',
    ]);
    expect(choicesForSource(choices, 'text_clip').map((choice) => choice.ref)).toEqual(['clip_1']);
  });

  it('knows when there is anywhere to draw from other than the keyboard', () => {
    expect(hasAlternativeSources(['inline'])).toBe(false);
    expect(hasAlternativeSources(['inline', 'notes_file'])).toBe(true);
  });
});

describe('how a script is recognised', () => {
  it('collapses whitespace, so a preview never opens on a blank line', () => {
    // A script's first line is very often blank or indented, and a preview starting empty reads as a
    // file that failed to load.
    expect(previewOf('\n\n   Once   upon\n a time  ')).toBe('Once upon a time');
  });

  it('truncates with an ellipsis rather than cutting mid-list', () => {
    expect(previewOf('abcdefghij', 5)).toBe('abcd…');
  });

  it('leaves something short exactly as it is', () => {
    expect(previewOf('short')).toBe('short');
  });
});
