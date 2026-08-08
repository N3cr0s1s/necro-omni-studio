import { describe, expect, it } from 'vitest';
import { assetPath, clipId, frameCount, frameIndex, frameSpan, staticNumber, trackId } from '@nos/core';
import type { TextClip, TimelineDocument } from '@nos/core';
import { type FileEntry, buildTree } from '@nos/media';
import { clipChoicesFrom, noteChoicesFrom, resolveTextChoice, textChoicesFrom } from './generator-text.js';

/**
 * The project's writing, as things a text parameter can be set to.
 *
 * The two decisions here are about *this project* and neither is one a rendering test could make:
 * what counts as writing, and what it is called.
 */

function file(path: string): FileEntry {
  return { path: assetPath(path), sizeBytes: 10, isDirectory: false };
}

function tree() {
  return buildTree([
    file('notes/script.md'),
    file('notes/outline.txt'),
    file('notes/reference.png'),
    file('media/interview.mp4'),
    file('project.json'),
  ]);
}

function textClip(id: string, start: number, text: string, label?: string): TextClip {
  return {
    id: clipId(id),
    kind: 'text',
    span: frameSpan(frameIndex(start), frameCount(30)),
    content: {
      text,
      font: 'sans-serif',
      size: 48,
      weight: 400,
      color: { r: 1, g: 1, b: 1, a: 1 },
      align: 'center',
      lineHeight: 1.2,
      letterSpacing: 0,
    },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    enabled: true,
    effects: [],
    ...(label !== undefined ? { label } : {}),
  } as TextClip;
}

function document(clips: readonly TextClip[]): TimelineDocument {
  return {
    frameRate: { numerator: 30, denominator: 1 },
    resolution: { width: 1920, height: 1080 },
    sequence: {
      id: 'main',
      tracks: [{ id: trackId('T1'), kind: 'text', name: 'T1', height: 46, clips }],
    },
  } as unknown as TimelineDocument;
}

describe('notes offered as a script', () => {
  it('offers what is written under notes/ and nothing else', () => {
    // Every other folder holds material. A picker offering `project.json` as a script offers a mistake.
    expect(noteChoicesFrom(tree()).map((choice) => choice.ref)).toEqual([
      'notes/outline.txt',
      'notes/script.md',
    ]);
  });

  it('leaves a picture in notes/ alone rather than guessing at it', () => {
    expect(noteChoicesFrom(tree()).some((choice) => choice.ref.endsWith('.png'))).toBe(false);
  });

  it('is empty with no project open, rather than throwing', () => {
    expect(noteChoicesFrom(undefined)).toEqual([]);
  });

  it('leaves the preview empty until something reads the file', () => {
    // A listing knows names, not contents, and blocking a panel render on reading every note would be
    // the wrong trade. Empty rather than a placeholder, so an unread note looks like an empty one —
    // which it may well be.
    expect(noteChoicesFrom(tree()).every((choice) => choice.preview === '')).toBe(true);
  });
});

describe('text clips offered as a script', () => {
  it('lists them in the order they play, not the order they are stored', () => {
    // A script read aloud follows the cut.
    const choices = clipChoicesFrom(document([textClip('c2', 90, 'second'), textClip('c1', 0, 'first')]));
    expect(choices.map((choice) => choice.ref)).toEqual(['c1', 'c2']);
  });

  it('calls a clip by its label when it has one', () => {
    const choices = clipChoicesFrom(document([textClip('c1', 0, 'Hello world', 'Opening title')]));
    expect(choices[0]?.label).toBe('Opening title');
  });

  it('falls back to what an untitled clip says, which is the only thing about it the user chose', () => {
    const choices = clipChoicesFrom(document([textClip('c1', 0, 'Hello world')]));
    expect(choices[0]?.label).toBe('Hello world');
  });

  it('carries the words, so the list is readable', () => {
    const choices = clipChoicesFrom(document([textClip('c1', 0, 'Hello   world')]));
    expect(choices[0]?.preview).toBe('Hello world');
  });
});

describe('resolving what was chosen', () => {
  const read = async (path: string): Promise<string> => {
    if (path === 'notes/script.md') return '# Title\n\nThe body.';
    throw new Error('missing');
  };

  it('reads a note through the caller´s reader', () => {
    return expect(
      resolveTextChoice(
        { source: 'notes_file', ref: 'notes/script.md', label: 'script.md', preview: '' },
        document([]),
        read,
      ),
    ).resolves.toBe('# Title\n\nThe body.');
  });

  it('reads a clip´s own text out of the document', () => {
    return expect(
      resolveTextChoice(
        { source: 'text_clip', ref: 'c1', label: 'Title', preview: '' },
        document([textClip('c1', 0, 'spoken line')]),
        read,
      ),
    ).resolves.toBe('spoken line');
  });

  it('is nothing for a note deleted since the panel listed it', () => {
    // Not an empty string: substituting one would submit a job that generates silence and reports
    // success, where `undefined` lets the caller refuse the run and say why.
    return expect(
      resolveTextChoice(
        { source: 'notes_file', ref: 'notes/gone.md', label: 'gone.md', preview: '' },
        document([]),
        read,
      ),
    ).resolves.toBeUndefined();
  });

  it('is nothing for a clip removed from the timeline', () => {
    return expect(
      resolveTextChoice(
        { source: 'text_clip', ref: 'c9', label: 'Title', preview: '' },
        document([textClip('c1', 0, 'still here')]),
        read,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('everything a text parameter could draw on', () => {
  it('is both sources in one list, which the panel splits by what each parameter declares', () => {
    const choices = textChoicesFrom(tree(), document([textClip('c1', 0, 'line')]));
    expect(choices.filter((choice) => choice.source === 'notes_file')).toHaveLength(2);
    expect(choices.filter((choice) => choice.source === 'text_clip')).toHaveLength(1);
  });
});
