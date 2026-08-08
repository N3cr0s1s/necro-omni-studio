// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  type FrameIndex,
  type TimelineDocument,
  FRAME_RATES,
  createDocument,
  endExclusive,
  frameIndex,
  projectId,
  sequenceId,
  trackId,
} from '@nos/core';
import { playbackEnd, useWorkRange } from './use-work-range.js';

/**
 * The in/out actions as the application drives them.
 *
 * The operations themselves are tested in `@nos/editing`. What is tested here is the wiring an
 * editor actually feels: that the keys reach the actions, that they act on the *current* document
 * rather than the one that existed when the listener was attached, and that typing in a field does
 * not move the in point.
 */

afterEach(cleanup);

function emptyDocument(): TimelineDocument {
  return createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
}

interface Harness {
  readonly document: () => TimelineDocument;
  readonly commits: string[];
  readonly seeks: FrameIndex[];
  setPlayhead: (frame: number) => void;
  notice: () => string | undefined;
}

/**
 * Mounts the hook over a real state holder.
 *
 * A real document that the hook's own commits feed back into, rather than a spy: the stale-closure
 * bug this guards against only appears when the document changes between mounting and pressing.
 */
function mount(initial = emptyDocument()): Harness {
  const commits: string[] = [];
  const seeks: FrameIndex[] = [];
  let current = initial;
  let setPlayheadExternal: (frame: number) => void = () => {};
  let latestNotice: string | undefined;

  function Host(): null {
    const [document, setDocument] = useState(initial);
    const [playhead, setPlayhead] = useState<FrameIndex>(frameIndex(0));
    setPlayheadExternal = (frame) => setPlayhead(frameIndex(frame));
    current = document;

    const range = useWorkRange({
      document,
      playhead,
      commit: (label, next) => {
        commits.push(label);
        setDocument(next);
      },
      seek: (frame) => {
        seeks.push(frame);
        setPlayhead(frame);
      },
    });
    latestNotice = range.notice;
    return null;
  }

  render(<Host />);
  return {
    document: () => current,
    commits,
    seeks,
    setPlayhead: (frame) => act(() => setPlayheadExternal(frame)),
    notice: () => latestNotice,
  };
}

function press(key: string, modifiers: { alt?: boolean; ctrl?: boolean } = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        altKey: modifiers.alt ?? false,
        ctrlKey: modifiers.ctrl ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function bounds(document: TimelineDocument): [number, number] | undefined {
  const range = document.sequence.workRange;
  return range === undefined ? undefined : [range.start, endExclusive(range)];
}

describe('marking', () => {
  it('marks in at the playhead', () => {
    const harness = mount();
    harness.setPlayhead(120);
    press('i');

    expect(bounds(harness.document())?.[0]).toBe(120);
  });

  it('marks out at the playhead, including its frame', () => {
    const harness = mount();
    harness.setPlayhead(200);
    press('o');

    expect(bounds(harness.document())?.[1]).toBe(201);
  });

  it('acts on the document as it is now, not as it was at mount', () => {
    // The handlers are attached once to the window, so a closure over the mounting document would
    // silently discard everything done since — the failure mode this ref exists to prevent.
    const harness = mount();
    harness.setPlayhead(50);
    press('i');
    harness.setPlayhead(80);
    press('o');

    expect(bounds(harness.document())).toEqual([50, 81]);
  });

  it('records one history entry per mark', () => {
    const harness = mount();
    harness.setPlayhead(50);
    press('i');
    press('o');

    expect(harness.commits).toEqual(['mark in', 'mark out']);
  });

  it('says so when a mark moved the other one', () => {
    const harness = mount();
    harness.setPlayhead(50);
    press('i');
    harness.setPlayhead(200);
    press('o');
    harness.setPlayhead(900);
    press('i');

    expect(harness.notice()).toContain('out point moved');
  });

  it('stays quiet about an ordinary mark', () => {
    const harness = mount();
    harness.setPlayhead(50);
    press('i');
    expect(harness.notice()).toBeUndefined();
  });
});

describe('clearing', () => {
  it('clears the range on alt+x', () => {
    const harness = mount();
    harness.setPlayhead(50);
    press('i');
    press('x', { alt: true });

    expect(harness.document().sequence.workRange).toBeUndefined();
  });

  it('records nothing when there is no range to clear', () => {
    // An undo entry that undoes nothing is worse than the key doing nothing.
    const harness = mount();
    press('x', { alt: true });
    expect(harness.commits).toEqual([]);
  });
});

describe('markers', () => {
  it('adds one at the playhead, labelled by its position', () => {
    // No dialog between the user and a marker: a prompt is what stops markers from being used.
    const harness = mount();
    harness.setPlayhead(90);
    press('m');

    expect(harness.document().sequence.markers).toEqual([{ frame: 90, label: '00:00:03:00' }]);
  });

  it('removes the one under the playhead on alt+m', () => {
    const harness = mount();
    harness.setPlayhead(90);
    press('m');
    press('m', { alt: true });

    expect(harness.document().sequence.markers).toEqual([]);
  });

  it('jumps between them without ever moving the wrong way', () => {
    const harness = mount();
    harness.setPlayhead(30);
    press('m');
    harness.setPlayhead(150);
    press('m');

    harness.setPlayhead(90);
    press('ArrowRight', { alt: true });
    expect(harness.seeks.at(-1)).toBe(150);

    press('ArrowLeft', { alt: true });
    expect(harness.seeks.at(-1)).toBe(30);
  });

  it('does nothing when there is no marker that way', () => {
    const harness = mount();
    harness.setPlayhead(90);
    press('m');
    press('ArrowRight', { alt: true });

    expect(harness.seeks).toEqual([]);
  });
});

describe('keys that must not fire', () => {
  it('ignores a key typed into a text field', () => {
    // Typing a prompt must never move the in point.
    const harness = mount();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
    });

    expect(harness.document().sequence.workRange).toBeUndefined();
    input.remove();
  });

  it('leaves modified keys to the application', () => {
    // Ctrl+I and friends belong to menus and the browser, not to marking.
    const harness = mount();
    press('i', { ctrl: true });
    expect(harness.commits).toEqual([]);
  });

  it('ignores keys it does not own', () => {
    const harness = mount();
    press('q');
    expect(harness.commits).toEqual([]);
  });
});

describe('playback bounds', () => {
  it('stops at the end of the sequence when nothing is marked', () => {
    expect(playbackEnd(emptyDocument(), 300)).toBe(300);
  });

  it('stops at the out point when one is', () => {
    // The preview has to agree with the file it previews: the same range bounds both.
    const harness = mount();
    harness.setPlayhead(100);
    press('i');
    harness.setPlayhead(150);
    press('o');

    expect(playbackEnd(harness.document(), 300)).toBe(151);
  });
});

describe('notices', () => {
  it('expires, so a message never outlives what it described', () => {
    vi.useFakeTimers();
    try {
      const harness = mount();
      harness.setPlayhead(50);
      press('i');
      harness.setPlayhead(900);
      press('i');
      expect(harness.notice()).toBeDefined();

      act(() => void vi.advanceTimersByTime(6000));
      expect(harness.notice()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
