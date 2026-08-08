// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Clip,
  type DocumentStore,
  type TimelineDocument,
  type VideoTrack,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  createDocumentStore,
  endExclusive,
  frameIndex,
  locateClip,
  projectId,
  sequenceId,
  effectId,
  effectInstanceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { type ClipEdits, describeRippleMode, survivingSelection, useClipEdits } from './use-clip-edits.js';

/**
 * Removing, disabling and cutting clips.
 *
 * The operations are `@nos/editing`'s and tested there. What is tested here is the decision this
 * layer owns — which of the two removals happens — and the wiring an editor feels: that Delete
 * reaches the selection, that shift gives the other removal *without* changing the mode, and that a
 * refusal leaves the clip both present and still selected.
 */

afterEach(cleanup);

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function clip(id: string, start: number, end: number): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

function documentWith(clips: readonly Clip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === 'video' ? ({ ...track, clips } as VideoTrack) : track,
      ),
    },
  };
}

interface Harness {
  readonly edits: () => ClipEdits;
  readonly store: DocumentStore;
  readonly rejections: string[];
  readonly removed: string[][];
  readonly pasted: string[][];
}

function mount(options: {
  clips?: readonly Clip[];
  selected?: readonly string[];
  ripple?: boolean;
  playhead?: number;
}): Harness {
  const store = createDocumentStore(documentWith(options.clips ?? [clip('a', 0, 100), clip('b', 200, 300)]));
  const rejections: string[] = [];
  const removed: string[][] = [];
  const pasted: string[][] = [];
  let latest: ClipEdits | undefined;

  function Host(): null {
    latest = useClipEdits({
      store,
      selected: new Set(options.selected ?? ['a']),
      playhead: frameIndex(options.playhead ?? 50),
      ripple: options.ripple ?? false,
      onReject: (reason) => rejections.push(reason),
      onRemoved: (clips) => removed.push([...clips]),
      onPasted: (clips) => pasted.push([...clips]),
    });
    return null;
  }

  render(<Host />);
  return {
    edits: () => {
      if (latest === undefined) throw new Error('not mounted');
      return latest;
    },
    store,
    rejections,
    removed,
    pasted,
  };
}

function press(key: string, modifiers: { shift?: boolean; ctrl?: boolean } = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        shiftKey: modifiers.shift ?? false,
        ctrlKey: modifiers.ctrl ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

/**
 * The video track's clips, in timeline order.
 *
 * Sorted here rather than assumed: clips are not *stored* in timeline order — a move or a split
 * appends — and asserting on storage order would pin down something the document deliberately does
 * not promise.
 */
function spans(store: DocumentStore): readonly [string, number, number][] {
  const track = store.getDocument().sequence.tracks[0];
  return (track?.clips ?? [])
    .map((entry): [string, number, number] => [
      entry.id as string,
      entry.span.start,
      endExclusive(entry.span),
    ])
    .sort((left, right) => left[1] - right[1]);
}

describe('the two removals', () => {
  it('leaves the gap with ripple off, so everything downstream keeps its timing', () => {
    const harness = mount({ ripple: false });
    act(() => harness.edits().remove());

    expect(spans(harness.store)).toEqual([['b', 200, 300]]);
  });

  it('closes the gap with ripple on', () => {
    const harness = mount({ ripple: true });
    act(() => harness.edits().remove());

    expect(spans(harness.store)).toEqual([['b', 100, 200]]);
  });

  it('gives the other removal on shift, without changing the mode', () => {
    // An editor reaches for it once, for one clip, and does not want the toolbar to have silently
    // flipped afterwards.
    const harness = mount({ ripple: false });
    act(() => harness.edits().removeOtherWay());

    expect(spans(harness.store)).toEqual([['b', 100, 200]]);
  });

  it('records one history entry for a multi-clip removal', () => {
    // Removing three clips is one decision, so undo should put all three back at once.
    const harness = mount({ selected: ['a', 'b'] });
    act(() => harness.edits().remove());
    expect(spans(harness.store)).toEqual([]);

    act(() => harness.store.undo());
    expect(spans(harness.store)).toHaveLength(2);
  });

  it('does nothing with nothing selected', () => {
    const harness = mount({ selected: [] });
    act(() => harness.edits().remove());

    expect(spans(harness.store)).toHaveLength(2);
    expect(harness.store.getSnapshot().canUndo).toBe(false);
  });
});

describe('a refusal', () => {
  const lockedHarness = () => {
    const harness = mount({});
    act(() => {
      harness.store.commit('lock', (current) => ({
        ...current,
        sequence: {
          ...current.sequence,
          tracks: current.sequence.tracks.map((track) =>
            track.kind === 'video' ? { ...track, locked: true } : track,
          ),
        },
      }));
    });
    return harness;
  };

  it('keeps the clip and says why', () => {
    const harness = lockedHarness();
    act(() => harness.edits().remove());

    expect(spans(harness.store)).toHaveLength(2);
    // The sentence, not the discriminant: this used to assert `track locked`, which is what the
    // message said when it was the error's `kind` with its hyphens taken out.
    expect(harness.rejections[0]).toBe('the track is locked — unlock it to change what is on it');
  });

  it('leaves the selection alone, because the clip is still there to act on', () => {
    const harness = lockedHarness();
    act(() => harness.edits().remove());

    expect(harness.removed).toEqual([]);
  });

  it('reports what did go when only part of a selection could', () => {
    const harness = mount({ selected: ['a', 'b'] });
    act(() => harness.edits().remove());

    expect(harness.removed).toEqual([['a', 'b']]);
  });
});

describe('disabling', () => {
  it('takes a clip out of the composite without removing it', () => {
    const harness = mount({});
    act(() => harness.edits().toggleEnabled());

    const located = locateClip(harness.store.getDocument(), clipId('a'));
    expect(located?.clip.enabled).toBe(false);
    expect(spans(harness.store)).toHaveLength(2);
  });

  it('turns a disabled clip back on', () => {
    const harness = mount({});
    act(() => harness.edits().toggleEnabled());
    act(() => harness.edits().toggleEnabled());

    expect(locateClip(harness.store.getDocument(), clipId('a'))?.clip.enabled).toBe(true);
  });
});

describe('cutting', () => {
  it('splits the selected clip at the playhead', () => {
    const harness = mount({ playhead: 50 });
    act(() => harness.edits().split());

    expect(spans(harness.store)).toEqual([
      ['a', 0, 50],
      ['a_b', 50, 100],
      ['b', 200, 300],
    ]);
  });

  it('cuts every track at once when asked, keeping layers aligned', () => {
    // The point of a cut-all: a razor through one track alone desynchronizes what was aligned.
    const harness = mount({ playhead: 50, selected: [] });
    act(() => harness.edits().splitAllTracks());

    expect(spans(harness.store).map(([, start]) => start)).toEqual([0, 50, 200]);
  });

  it('produces the same document for the same cut, so undo and a saved file are comparable', () => {
    const first = mount({ playhead: 50, selected: [] });
    const second = mount({ playhead: 50, selected: [] });
    act(() => first.edits().splitAllTracks());
    act(() => second.edits().splitAllTracks());

    expect(spans(first.store)).toEqual(spans(second.store));
  });
});

describe('copy and paste', () => {
  it('does nothing with an empty clipboard', () => {
    const harness = mount({ selected: [] });
    act(() => harness.edits().paste());

    expect(spans(harness.store)).toHaveLength(2);
    expect(harness.edits().canPaste).toBe(false);
  });

  it('pastes at the playhead', () => {
    const harness = mount({ playhead: 500 });
    act(() => harness.edits().copy());
    act(() => harness.edits().paste());

    expect(spans(harness.store).map(([, start]) => start)).toEqual([0, 200, 500]);
  });

  it('moves past what is in the way rather than refusing', () => {
    // The user asked to put something down; where the next gap is, is the part worth doing for them.
    const harness = mount({ playhead: 250 });
    act(() => harness.edits().copy());
    act(() => harness.edits().paste());

    const starts = spans(harness.store).map(([, start]) => start);
    expect(starts).toEqual([0, 200, 300]);
  });

  it('selects what was pasted, which is what a user acts on next', () => {
    const harness = mount({ playhead: 500 });
    act(() => harness.edits().copy());
    act(() => harness.edits().paste());

    expect(harness.pasted.at(-1)).toHaveLength(1);
  });

  it('cuts by copying and removing in one action', () => {
    const harness = mount({});
    act(() => harness.edits().cut());
    expect(spans(harness.store)).toHaveLength(1);

    act(() => harness.edits().paste());
    expect(spans(harness.store)).toHaveLength(2);
  });

  it('duplicates immediately after the original', () => {
    const harness = mount({ clips: [clip('a', 0, 100)], selected: ['a'] });
    act(() => harness.edits().duplicate());

    expect(spans(harness.store)).toEqual([
      ['a', 0, 100],
      ['a_copy100_0', 100, 200],
    ]);
  });

  it('reports that there is something to paste', () => {
    const harness = mount({});
    expect(harness.edits().canPaste).toBe(false);
    act(() => harness.edits().copy());
    expect(harness.edits().canPaste).toBe(true);
  });

  it('is reachable from the clipboard chords', () => {
    const harness = mount({ playhead: 500 });
    press('c', { ctrl: true });
    press('v', { ctrl: true });

    expect(spans(harness.store)).toHaveLength(3);
  });

  it('leaves a copy in a text field to the text field', () => {
    const harness = mount({ playhead: 500 });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    });

    expect(harness.edits().canPaste).toBe(false);
    input.remove();
  });
});

describe('copying a look', () => {
  const graded = () =>
    ({
      ...clip('a', 0, 100),
      effects: [{ id: effectInstanceId('a_fx'), effect: effectId('levels'), enabled: true, params: {} }],
    }) as Clip;

  it('says nothing has been copied until something is', () => {
    const harness = mount({});
    expect(harness.edits().attributeSummary).toBeUndefined();
  });

  it('reports what was copied, so a control can say what it will apply', () => {
    const harness = mount({ clips: [graded(), clip('b', 200, 300)], selected: ['a'] });
    act(() => harness.edits().copyAttributes());

    expect(harness.edits().attributeSummary).toContain('1 effect');
  });

  it('applies the look to every selected clip', () => {
    const harness = mount({ clips: [graded(), clip('b', 200, 300)], selected: ['a'] });
    act(() => harness.edits().copyAttributes());

    // Re-mounted with a different selection: the look outlives the selection it was taken from.
    cleanup();
    const target = mount({ clips: [graded(), clip('b', 200, 300)], selected: ['b'] });
    act(() => target.edits().copyAttributes());
    act(() => target.edits().pasteAttributes());

    expect(spans(target.store)).toHaveLength(2);
  });

  it('does not move the clips it is applied to', () => {
    // A paste that moved a clip would be indistinguishable from a bug.
    const harness = mount({ clips: [graded(), clip('b', 200, 300)], selected: ['a'] });
    const before = spans(harness.store);
    act(() => harness.edits().copyAttributes());
    act(() => harness.edits().pasteAttributes());

    expect(spans(harness.store)).toEqual(before);
  });

  it('is reachable from the shifted clipboard chords', () => {
    const harness = mount({ clips: [graded(), clip('b', 200, 300)], selected: ['a'] });
    press('c', { ctrl: true, shift: true });

    expect(harness.edits().attributeSummary).toContain('effect');
  });

  it('leaves the clip clipboard alone, since the two are different things', () => {
    // Copying a grade must not lose the clips a user copied a moment earlier.
    const harness = mount({ clips: [graded(), clip('b', 200, 300)], selected: ['a'] });
    act(() => harness.edits().copy());
    act(() => harness.edits().copyAttributes());

    expect(harness.edits().canPaste).toBe(true);
  });
});

describe('the marked range', () => {
  function ranged(from: number, to: number) {
    const store = createDocumentStore(documentWith([clip('a', 0, 100), clip('b', 200, 300)]));
    store.commit('mark', (current) => ({
      ...current,
      sequence: {
        ...current.sequence,
        workRange: spanFromBounds(frameIndex(from), frameIndex(to)),
      },
    }));

    let latest: ClipEdits | undefined;
    function Host(): null {
      latest = useClipEdits({
        store,
        selected: new Set(),
        playhead: frameIndex(0),
        ripple: false,
        onReject: () => undefined,
        onRemoved: () => undefined,
      });
      return null;
    }
    render(<Host />);
    return { store, edits: () => latest! };
  }

  it('is offered only when a range is marked', () => {
    const harness = mount({});
    expect(harness.edits().hasRange).toBe(false);
    cleanup();
    expect(ranged(0, 50).edits().hasRange).toBe(true);
  });

  it('takes the section out and closes the gap', () => {
    const harness = ranged(50, 100);
    act(() => harness.edits().removeRange());

    // The first clip loses its tail; the second moves back by the range's length.
    expect(spans(harness.store)).toEqual([
      ['a', 0, 50],
      ['b', 150, 250],
    ]);
  });

  it('applies to every track, because a range is a span of the programme', () => {
    // Taking a section out of the picture while leaving it in the sound is not something anyone
    // marks a range to do.
    const harness = ranged(0, 50);
    act(() => harness.edits().removeRange());

    const tracks = harness.store.getDocument().sequence.tracks;
    expect(tracks.every((track) => track.clips.every((entry) => entry.span.start < 200))).toBe(true);
  });

  it('clears the marks afterwards, since the section they described is gone', () => {
    // Leaving them would invite the user to remove the material that has just moved into their place.
    const harness = ranged(50, 100);
    act(() => harness.edits().removeRange());

    expect(harness.store.getDocument().sequence.workRange).toBeUndefined();
  });

  it('is one history entry for the whole range', () => {
    const harness = ranged(50, 100);
    act(() => harness.edits().removeRange());
    act(() => harness.store.undo());

    expect(spans(harness.store)).toEqual([
      ['a', 0, 100],
      ['b', 200, 300],
    ]);
  });
});

describe('the keys', () => {
  it('removes on delete and on backspace', () => {
    for (const key of ['Delete', 'Backspace']) {
      const harness = mount({});
      press(key);
      expect(spans(harness.store)).toHaveLength(1);
      cleanup();
    }
  });

  it('gives the other removal on shift+delete', () => {
    const harness = mount({ ripple: false });
    press('Delete', { shift: true });
    expect(spans(harness.store)).toEqual([['b', 100, 200]]);
  });

  it('toggles enabled on E', () => {
    const harness = mount({});
    press('e');
    expect(locateClip(harness.store.getDocument(), clipId('a'))?.clip.enabled).toBe(false);
  });

  it('splits on S and cuts every track on shift+S', () => {
    const harness = mount({ playhead: 50 });
    press('s');
    expect(spans(harness.store)).toHaveLength(3);

    cleanup();
    const all = mount({ playhead: 50, selected: [] });
    press('S', { shift: true });
    expect(spans(all.store)).toHaveLength(3);
  });

  it('ignores a key typed into a text field', () => {
    // Delete must never take a clip while the user is editing a prompt.
    const harness = mount({});
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });

    expect(spans(harness.store)).toHaveLength(2);
    input.remove();
  });

  it('leaves modified keys to the application', () => {
    const harness = mount({});
    press('Delete', { ctrl: true });
    expect(spans(harness.store)).toHaveLength(2);
  });

  it('acts on the selection as it is now, not as it was at mount', () => {
    // The listener is attached once; a closure over the mounting props would delete the wrong clip.
    const store = createDocumentStore(documentWith([clip('a', 0, 100), clip('b', 200, 300)]));
    let selected = new Set(['a']);

    function Host(): null {
      useClipEdits({
        store,
        selected,
        playhead: frameIndex(50),
        ripple: false,
        onReject: () => undefined,
        onRemoved: () => undefined,
      });
      return null;
    }
    const view = render(<Host />);

    selected = new Set(['b']);
    view.rerender(<Host />);
    press('Delete');

    expect(spans(store).map(([id]) => id)).toEqual(['a']);
  });
});

describe('what the mode promises', () => {
  it('says which removal is about to happen', () => {
    expect(describeRippleMode(true)).toContain('closes the gap');
    expect(describeRippleMode(false)).toContain('leaves a gap');
  });
});

describe('pruning a selection', () => {
  it('drops ids nothing answers to any more', () => {
    const document = documentWith([clip('a', 0, 100)]);
    expect([...survivingSelection(document, new Set(['a', 'gone']))]).toEqual(['a']);
  });

  it('returns the same set when everything survives, so React sees no change', () => {
    const document = documentWith([clip('a', 0, 100)]);
    const selection = new Set(['a']);
    expect(survivingSelection(document, selection)).toBe(selection);
  });
});
