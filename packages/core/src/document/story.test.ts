import { describe, expect, it } from 'vitest';
import { assetPath, storyBeatId } from './ids.js';
import { frameIndex } from '../time/frame-time.js';
import { spanFromBounds } from '../time/frame-span.js';
import { type StoryBeat, accentOf, beatAt, beatReferences, beatsInOrder, nextBeatStart } from './story.js';

/**
 * The story board, per issue #33.
 *
 * A beat says when something should happen, what it is in prose, and what it should look like by
 * pointing at material already in the project. A plan, not a render.
 */

const beat = (id: string, from: number, to: number, over: Partial<StoryBeat> = {}): StoryBeat => ({
  id: storyBeatId(id),
  span: spanFromBounds(frameIndex(from), frameIndex(to)),
  title: '',
  notes: '',
  references: [],
  ...over,
});

describe('the accent a beat is drawn in', () => {
  it('is the one it names', () => {
    expect(accentOf(beat('a', 0, 10, { accent: 4 }))).toBe(4);
  });

  it('is the first when it names none, so an unset beat is not invisible', () => {
    expect(accentOf(beat('a', 0, 10))).toBe(1);
  });
});

describe('the order they happen in', () => {
  it('is by start', () => {
    const ordered = beatsInOrder([beat('b', 100, 200), beat('a', 0, 50)]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('breaks a tie by id, so two beats on one frame do not swap between renders', () => {
    const ordered = beatsInOrder([beat('z', 0, 10), beat('a', 0, 20)]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'z']);
  });

  it('leaves the given list alone', () => {
    // Sorted on read, not on write: a beat being dragged passes through every position between where
    // it was and where it lands, and a list that reordered itself under the pointer is the one
    // behaviour a timeline must not have.
    const beats = [beat('b', 100, 200), beat('a', 0, 50)];
    beatsInOrder(beats);
    expect(beats.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});

describe('the beat covering a frame', () => {
  const beats = [beat('a', 0, 100), beat('b', 100, 200)];

  it('is the one whose span contains it', () => {
    expect(beatAt(beats, 50)?.id).toBe('a');
    expect(beatAt(beats, 150)?.id).toBe('b');
  });

  it('treats the end as exclusive, so touching beats do not both claim a frame', () => {
    expect(beatAt(beats, 100)?.id).toBe('b');
  });

  it('is nothing outside every beat', () => {
    expect(beatAt(beats, 500)).toBeUndefined();
    expect(beatAt([], 0)).toBeUndefined();
  });

  it('is the last of several that overlap, which is the one drawn on top', () => {
    const overlapping = [beat('under', 0, 100), beat('over', 0, 100)];
    expect(beatAt(overlapping, 50)?.id).toBe('over');
  });
});

describe('the material a board references', () => {
  it('is every asset, once each, in the order the beats happen', () => {
    const beats = [
      beat('b', 100, 200, { references: [{ asset: assetPath('media/two.png') }] }),
      beat('a', 0, 50, { references: [{ asset: assetPath('media/one.png') }] }),
    ];
    expect(beatReferences(beats)).toEqual(['media/one.png', 'media/two.png']);
  });

  it('does not repeat one two beats share', () => {
    const shared = assetPath('media/one.png');
    const beats = [
      beat('a', 0, 50, { references: [{ asset: shared }] }),
      beat('b', 100, 200, { references: [{ asset: shared }] }),
    ];
    expect(beatReferences(beats)).toEqual(['media/one.png']);
  });

  it('is empty for a board that references nothing', () => {
    expect(beatReferences([beat('a', 0, 50)])).toEqual([]);
  });
});

describe('where an added beat should start', () => {
  it('is the frame asked for when nothing starts there', () => {
    expect(nextBeatStart([beat('a', 0, 100)], 200)).toBe(200);
  });

  it('is past a beat that already starts there', () => {
    // Beats are added at the playhead and the playhead does not move on its own, so without this a
    // second press of the button buries the beat the first one made.
    expect(nextBeatStart([beat('a', 0, 100)], 0)).toBe(100);
  });

  it('clears the longest of several starting on that frame', () => {
    expect(nextBeatStart([beat('short', 0, 50), beat('long', 0, 300)], 0)).toBe(300);
  });

  it('keeps going down a chain of beats that each start where the last ended', () => {
    const chain = [beat('a', 0, 100), beat('b', 100, 200), beat('c', 200, 300)];
    expect(nextBeatStart(chain, 0)).toBe(300);
  });

  it('terminates rather than spinning when every frame it tries is taken', () => {
    // The bound is the number of beats, and each pass resolves at least one clash.
    const chain = Array.from({ length: 20 }, (_, index) => beat(`b${index}`, index * 10, index * 10 + 10));
    expect(nextBeatStart(chain, 0)).toBe(200);
  });

  it('leaves overlap possible, because two ideas about one moment is a real thing to want', () => {
    // Only an *exact* shared start is moved. Dropping a beat inside another one is left alone.
    expect(nextBeatStart([beat('a', 0, 100)], 50)).toBe(50);
  });

  it('is the frame asked for on an empty board', () => {
    expect(nextBeatStart([], 0)).toBe(0);
  });
});
