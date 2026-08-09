// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
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
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { type TimelineView, useTimelineView, wheelScrollPx } from './use-timeline-view.js';

/**
 * Where the timeline looks.
 *
 * The viewport could zoom and nothing else, so playback ran off the right edge with the timeline
 * sitting still. What is pinned down here is when the view moves *by itself* — following the playhead
 * is welcome during playback and an interruption at any other time — and that undo finally has a key.
 */

afterEach(cleanup);

function clip(id: string, start: number, end: number): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

function documentWith(clips: readonly Clip[], workRange?: readonly [number, number]): TimelineDocument {
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
      ...(workRange !== undefined
        ? { workRange: spanFromBounds(frameIndex(workRange[0]), frameIndex(workRange[1])) }
        : {}),
      tracks: base.sequence.tracks.map((track) =>
        track.kind === 'video' ? ({ ...track, clips } as VideoTrack) : track,
      ),
    },
  };
}

interface Harness {
  readonly view: () => TimelineView;
  readonly store: DocumentStore;
  setPlayhead: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
}

function mount(
  options: { document?: TimelineDocument; widthPx?: number; selected?: ReadonlySet<string> } = {},
): Harness {
  const document = options.document ?? documentWith([clip('a', 0, 3000)]);
  const store = createDocumentStore(document);
  let latest: TimelineView | undefined;
  let setPlayheadExternal: (frame: number) => void = () => undefined;
  let setPlayingExternal: (playing: boolean) => void = () => undefined;

  function Host(): null {
    const [playhead, setPlayhead] = useState(frameIndex(0));
    const [playing, setPlaying] = useState(false);
    setPlayheadExternal = (frame) => setPlayhead(frameIndex(frame));
    setPlayingExternal = setPlaying;

    latest = useTimelineView({
      document,
      store,
      widthPx: options.widthPx ?? 1000,
      selected: options.selected ?? new Set<string>(),
      playhead,
      playing,
    });
    return null;
  }

  render(<Host />);
  return {
    view: () => {
      if (latest === undefined) throw new Error('not mounted');
      return latest;
    },
    store,
    setPlayhead: (frame) => act(() => setPlayheadExternal(frame)),
    setPlaying: (playing) => act(() => setPlayingExternal(playing)),
  };
}

function press(key: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: modifiers.ctrl ?? false,
        shiftKey: modifiers.shift ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('following the playhead', () => {
  it('scrolls when the playhead leaves the window during playback', () => {
    const harness = mount();
    harness.setPlaying(true);
    harness.setPlayhead(2000);

    expect(harness.view().viewport.scrollFrame).toBeGreaterThan(0);
  });

  it('does not move while the user is scrubbing', () => {
    // A user scrubbing is looking at something they chose to look at; yanking the view back fights
    // them, where during playback the playhead is the only thing worth looking at.
    const harness = mount();
    harness.setPlayhead(2000);

    expect(harness.view().viewport.scrollFrame).toBe(0);
  });

  it('stays put while the playhead is comfortably inside', () => {
    // Otherwise every frame of playback would scroll by a pixel.
    const harness = mount();
    harness.setPlaying(true);
    harness.setPlayhead(400);

    expect(harness.view().viewport.scrollFrame).toBe(0);
  });

  it('keeps the playhead visible once it has followed', () => {
    const harness = mount();
    harness.setPlaying(true);
    harness.setPlayhead(2000);

    const { scrollFrame, framesPerPixel } = harness.view().viewport;
    const px = (2000 - scrollFrame) / framesPerPixel;
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThan(1000);
  });
});

describe('zooming', () => {
  it('produces a whole frame, because a frame index refuses anything else', () => {
    // The anchor arithmetic lands on a fraction for almost every zoom step, and `frameIndex` throws
    // on one. Every wheel zoom used to throw for exactly this reason.
    const harness = mount();
    act(() => harness.view().zoomAt(0.8, 377));

    expect(Number.isInteger(harness.view().viewport.scrollFrame)).toBe(true);
  });

  it('survives a whole gesture of zoom steps', () => {
    const harness = mount();
    expect(() => {
      let zoom = 1;
      for (let step = 0; step < 12; step += 1) {
        zoom *= 0.8;
        act(() => harness.view().zoomAt(zoom, 900));
      }
    }).not.toThrow();
  });

  it('keeps the frame under the pointer under the pointer', () => {
    const harness = mount();
    const before = harness.view().viewport;
    const anchorFrame = before.scrollFrame + 500 * before.framesPerPixel;

    act(() => harness.view().zoomAt(0.5, 500));

    const after = harness.view().viewport;
    expect(after.scrollFrame + 500 * after.framesPerPixel).toBeCloseTo(anchorFrame, 0);
  });
});

describe('scrolling', () => {
  it('moves the view by a pixel delta', () => {
    const harness = mount();
    act(() => harness.view().scrollBy(200));

    expect(harness.view().viewport.scrollFrame).toBe(200);
  });

  it('never scrolls before the start of the sequence', () => {
    const harness = mount();
    act(() => harness.view().scrollBy(-500));

    expect(harness.view().viewport.scrollFrame).toBe(0);
  });
});

describe('the wheel', () => {
  it('reads a trackpad´s horizontal intent', () => {
    expect(wheelScrollPx({ deltaX: 40, deltaY: 0, shiftKey: false })).toBe(40);
  });

  it('takes shift as the stand-in a mouse wheel needs', () => {
    expect(wheelScrollPx({ deltaX: 0, deltaY: 40, shiftKey: true })).toBe(40);
  });

  it('leaves a plain vertical wheel alone', () => {
    expect(wheelScrollPx({ deltaX: 0, deltaY: 40, shiftKey: false })).toBe(0);
  });
});

describe('fitting', () => {
  it('frames the whole sequence', () => {
    const harness = mount({ document: documentWith([clip('a', 0, 3000)]) });
    act(() => harness.view().fit());

    const { framesPerPixel } = harness.view().viewport;
    expect(3000 / framesPerPixel).toBeLessThanOrEqual(1000);
    expect(3000 / framesPerPixel).toBeGreaterThan(500);
  });

  it('frames the marked range instead when there is one', () => {
    // A user who marked a section and asked to fit means that section, not the programme it sits in.
    const harness = mount({ document: documentWith([clip('a', 0, 3000)], [1000, 1300]) });
    act(() => harness.view().fit());

    const { scrollFrame, framesPerPixel } = harness.view().viewport;
    expect(scrollFrame).toBeGreaterThan(900);
    expect(300 / framesPerPixel).toBeGreaterThan(500);
  });

  it('frames the selection first of all, which is the narrowest thing pointed at', () => {
    // Having selected a clip and pressed Fit, the answer nobody means is "the whole programme".
    const harness = mount({
      document: documentWith([clip('a', 0, 3000), clip('b', 2000, 2300)]),
      selected: new Set(['b']),
    });
    act(() => harness.view().fit());

    const { scrollFrame, framesPerPixel } = harness.view().viewport;
    expect(scrollFrame).toBeGreaterThan(1900);
    expect(300 / framesPerPixel).toBeGreaterThan(500);
  });

  it('prefers the selection over the marked range, since it is the later statement of interest', () => {
    const harness = mount({
      document: documentWith([clip('a', 0, 3000), clip('b', 2000, 2300)], [100, 400]),
      selected: new Set(['b']),
    });
    act(() => harness.view().fit());
    expect(harness.view().viewport.scrollFrame).toBeGreaterThan(1900);
  });

  it('falls back to the marked range when the selection names nothing that exists', () => {
    // A selection can outlive its clips — an undo removes them — and framing nothing would leave the
    // view somewhere the user never asked for.
    const harness = mount({
      document: documentWith([clip('a', 0, 3000)], [1000, 1300]),
      selected: new Set(['vanished']),
    });
    act(() => harness.view().fit());
    expect(harness.view().viewport.scrollFrame).toBeGreaterThan(900);
  });

  it('survives an empty sequence rather than dividing by nothing', () => {
    const harness = mount({ document: documentWith([]) });
    act(() => harness.view().fit());

    expect(Number.isFinite(harness.view().viewport.framesPerPixel)).toBe(true);
  });
});

describe('the history keys', () => {
  it('undoes on ctrl+z', () => {
    const harness = mount();
    act(() => harness.store.commit('edit', (current) => ({ ...current, name: 'edited' })));
    press('z', { ctrl: true });

    expect(harness.store.getDocument().name).toBe('p');
  });

  it('redoes on ctrl+shift+z', () => {
    const harness = mount();
    act(() => harness.store.commit('edit', (current) => ({ ...current, name: 'edited' })));
    press('z', { ctrl: true });
    press('z', { ctrl: true, shift: true });

    expect(harness.store.getDocument().name).toBe('edited');
  });

  it('also redoes on ctrl+y, which is what a user arriving from elsewhere will try', () => {
    const harness = mount();
    act(() => harness.store.commit('edit', (current) => ({ ...current, name: 'edited' })));
    press('z', { ctrl: true });
    press('y', { ctrl: true });

    expect(harness.store.getDocument().name).toBe('edited');
  });

  it('leaves undo in a text field to the text field', () => {
    const harness = mount();
    act(() => harness.store.commit('edit', (current) => ({ ...current, name: 'edited' })));

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });

    expect(harness.store.getDocument().name).toBe('edited');
    input.remove();
  });

  it('fits on an unmodified F, because a view change is nothing to undo', () => {
    const harness = mount();
    press('f');

    expect(harness.view().viewport.framesPerPixel).not.toBe(1);
  });
});
