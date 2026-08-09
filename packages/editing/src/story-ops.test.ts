import { describe, expect, it } from 'vitest';
import {
  FRAME_RATES,
  type TimelineDocument,
  assetPath,
  createDocument,
  frameIndex,
  projectId,
  sequenceId,
  storyBeatId,
  trackId,
} from '@nos/core';
import {
  DEFAULT_BEAT_SECONDS,
  addBeat,
  attachReference,
  detachReference,
  editBeat,
  moveBeat,
  removeBeat,
} from './story-ops.js';

/**
 * Editing the story board, per issue #33.
 *
 * Document transforms like every other operation here, which is what puts the board under the same
 * undo, autosave and crash recovery as the cut.
 */

const empty = (): TimelineDocument =>
  createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'plan',
    // 30 fps, so a two-second beat is 60 frames and the arithmetic is checkable by eye.
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

describe('adding one', () => {
  it('lands where it was asked for, two seconds long', () => {
    const document = addBeat(empty(), frameIndex(90));
    expect(document.story).toHaveLength(1);
    expect(document.story[0]?.span.start).toBe(90);
    expect(document.story[0]?.span.duration).toBe(DEFAULT_BEAT_SECONDS * 30);
  });

  it('takes a length in seconds, at the project rate', () => {
    expect(addBeat(empty(), frameIndex(0), { seconds: 1.5 }).story[0]?.span.duration).toBe(45);
  });

  it('is never zero-length, whatever it was asked for', () => {
    // A beat of no length is invisible on the board and impossible to grab back.
    expect(addBeat(empty(), frameIndex(0), { seconds: 0 }).story[0]?.span.duration).toBe(1);
  });

  it('starts empty, because a beat is dropped first and written afterwards', () => {
    const beat = addBeat(empty(), frameIndex(0)).story[0];
    expect(beat?.title).toBe('');
    expect(beat?.notes).toBe('');
    expect(beat?.references).toEqual([]);
  });

  it('gives two beats at one frame different ids', () => {
    // A stable id from the frame keeps the file diffable; the suffix is what keeps it unique.
    const twice = addBeat(addBeat(empty(), frameIndex(30)), frameIndex(30));
    expect(new Set(twice.story.map((beat) => beat.id)).size).toBe(2);
  });

  it('names the id after the frame, so the same document serializes the same way twice', () => {
    // A random id would make an unchanged project produce a different file on every run, which is
    // unreadable in version control.
    expect(addBeat(empty(), frameIndex(30)).story[0]?.id).toBe('beat_30');
  });
});

describe('removing one', () => {
  it('removes only that beat', () => {
    const two = addBeat(addBeat(empty(), frameIndex(0)), frameIndex(120));
    const left = removeBeat(two, storyBeatId('beat_0'));
    expect(left.story.map((beat) => beat.id)).toEqual(['beat_120']);
  });

  it('ignores an id nothing holds', () => {
    const one = addBeat(empty(), frameIndex(0));
    expect(removeBeat(one, storyBeatId('gone')).story).toHaveLength(1);
  });
});

describe('changing one', () => {
  const withBeat = () => addBeat(empty(), frameIndex(0));
  const id = storyBeatId('beat_0');

  it('writes what was named', () => {
    const edited = editBeat(withBeat(), id, { title: 'Wide shot', notes: '# The dune' });
    expect(edited.story[0]?.title).toBe('Wide shot');
    expect(edited.story[0]?.notes).toBe('# The dune');
  });

  it('leaves alone what was not', () => {
    // The change-object rule this codebase follows everywhere.
    const titled = editBeat(withBeat(), id, { title: 'Wide shot' });
    expect(editBeat(titled, id, { notes: 'x' }).story[0]?.title).toBe('Wide shot');
  });

  it('clears the accent on null, and leaves it on absent', () => {
    // `undefined` already means "not mentioned", so clearing needs a value of its own.
    const accented = editBeat(withBeat(), id, { accent: 4 });
    expect(accented.story[0]?.accent).toBe(4);
    expect(editBeat(accented, id, { notes: 'x' }).story[0]?.accent).toBe(4);
    expect(editBeat(accented, id, { accent: null }).story[0]?.accent).toBeUndefined();
  });

  it('does not leave a cleared accent as an undefined field', () => {
    // An absent field is how the document says "the default"; `accent: undefined` would serialize as
    // `null`, which the schema rejects on the way back in.
    const cleared = editBeat(editBeat(withBeat(), id, { accent: 2 }), id, { accent: null });
    expect(Object.hasOwn(cleared.story[0]!, 'accent')).toBe(false);
  });

  it('never lets a span collapse to nothing', () => {
    const collapsed = editBeat(withBeat(), id, {
      span: { start: frameIndex(10), end: frameIndex(10) },
    });
    expect(collapsed.story[0]?.span.duration).toBe(1);
  });

  it('touches only the beat named', () => {
    const two = addBeat(addBeat(empty(), frameIndex(0)), frameIndex(120));
    const edited = editBeat(two, id, { title: 'changed' });
    expect(edited.story[1]?.title).toBe('');
  });
});

describe('moving one', () => {
  const withBeat = () => addBeat(empty(), frameIndex(120));
  const id = storyBeatId('beat_120');

  it('keeps its length', () => {
    const moved = moveBeat(withBeat(), id, frameIndex(300));
    expect(moved.story[0]?.span.start).toBe(300);
    expect(moved.story[0]?.span.duration).toBe(60);
  });

  it('stops at the start rather than refusing', () => {
    // Dragging off the left is a gesture with an obvious intent, and clamping is what every other drag
    // in this application does.
    const moved = moveBeat(withBeat(), id, frameIndex(-500));
    expect(moved.story[0]?.span.start).toBe(0);
    expect(moved.story[0]?.span.duration).toBe(60);
  });
});

describe('references', () => {
  const withBeat = () => addBeat(empty(), frameIndex(0));
  const id = storyBeatId('beat_0');
  const image = assetPath('media/frame.png');

  it('attaches one, with a note when given', () => {
    const attached = attachReference(withBeat(), id, image, 'the light in this');
    expect(attached.story[0]?.references).toEqual([{ asset: 'media/frame.png', note: 'the light in this' }]);
  });

  it('omits the note entirely when there is none', () => {
    expect(attachReference(withBeat(), id, image).story[0]?.references[0]).toEqual({
      asset: 'media/frame.png',
    });
  });

  it('does not attach the same asset twice', () => {
    // Repeating yourself is not a mistake worth reporting, and two identical rows would be the only
    // visible result.
    const twice = attachReference(attachReference(withBeat(), id, image), id, image);
    expect(twice.story[0]?.references).toHaveLength(1);
  });

  it('detaches by asset', () => {
    const attached = attachReference(withBeat(), id, image);
    expect(detachReference(attached, id, image).story[0]?.references).toEqual([]);
  });

  it('leaves other references alone', () => {
    const two = attachReference(attachReference(withBeat(), id, image), id, assetPath('media/other.png'));
    expect(detachReference(two, id, image).story[0]?.references).toEqual([{ asset: 'media/other.png' }]);
  });
});
