// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type VideoTrack,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  effectId,
  effectInstanceId,
  frameIndex,
  generatorId,
  jobRunId,
  maskId,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { Timeline, assetDropTarget, flushAfter, flushBefore, regionFor } from './Timeline.js';
import { COLLAPSED_TRACK_HEIGHT_PX } from './viewport.js';
import { clipAccessibleLabel } from './ClipBody.js';
import { createViewport } from './viewport.js';

afterEach(cleanup);

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

function makeDocument(clips: readonly Clip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
  const v1: VideoTrack = { ...(base.sequence.tracks[0] as VideoTrack), clips: clips as VideoTrack['clips'] };
  return { ...base, sequence: { ...base.sequence, tracks: [v1, ...base.sequence.tracks.slice(1)] } };
}

function renderTimeline(overrides: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const document = overrides.document ?? makeDocument([video('a', 0, 300), video('b', 400, 700)]);
  return render(
    <Timeline
      document={document}
      viewport={createViewport({ framesPerPixel: 4, widthPx: 1000, frameRate: document.frameRate })}
      playhead={frameIndex(100)}
      selectedClips={new Set()}
      snapEnabled
      rippleEnabled={false}
      {...overrides}
    />,
  );
}

describe('rendering', () => {
  it('renders one lane per track', () => {
    renderTimeline();
    expect(document.querySelectorAll('[data-track-id]')).toHaveLength(3);
  });

  it('renders visible clips', () => {
    renderTimeline();
    expect(document.querySelectorAll('[data-clip-id]')).toHaveLength(2);
  });

  it('skips off-screen clips, keeping the DOM proportional to what is visible', () => {
    // The viewport covers frames 0..4000; a clip at 90000 must not be rendered at all.
    const doc = makeDocument([video('near', 0, 300), video('far', 90_000, 90_300)]);
    renderTimeline({ document: doc });
    expect(document.querySelector('[data-clip-id="far"]')).toBeNull();
    expect(document.querySelector('[data-clip-id="near"]')).not.toBeNull();
  });

  it('shows the status line with rate, length and clip count', () => {
    renderTimeline();
    expect(screen.getByText('30 fps · 700 f · 2 clips')).toBeDefined();
  });

  it('shows the zoom readout the way the mockups do', () => {
    renderTimeline();
    expect(screen.getByText('4 f/px')).toBeDefined();
  });
});

describe('clip appearance', () => {
  it('marks generator output, so purple can be trusted to mean generated', () => {
    const doc = makeDocument([
      video('imported', 0, 100),
      video('made', 200, 300, {
        provenance: {
          generator: generatorId('t2v'),
          run: jobRunId('r1'),
          seed: 4471,
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      }),
    ]);
    renderTimeline({ document: doc });

    expect(document.querySelector('[data-clip-id="made"]')?.getAttribute('data-generated')).toBe('true');
    expect(document.querySelector('[data-clip-id="imported"]')?.getAttribute('data-generated')).toBe('false');
  });

  it('shows the seed on a generated clip, since reproducing a result needs it', () => {
    const doc = makeDocument([
      video('made', 0, 400, {
        provenance: {
          generator: generatorId('t2v'),
          run: jobRunId('r1'),
          seed: 4471,
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      }),
    ]);
    renderTimeline({ document: doc });
    expect(screen.getByText('seed 4471')).toBeDefined();
  });

  it('shows an effect count badge and a mask badge', () => {
    const doc = makeDocument([
      video('a', 0, 400, {
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: {},
            mask: maskId('m1'),
          },
          { id: effectInstanceId('fx2'), effect: effectId('levels'), enabled: true, params: {} },
        ],
      }),
    ]);
    renderTimeline({ document: doc });
    expect(screen.getByText('fx 2')).toBeDefined();
    expect(screen.getByText('mask')).toBeDefined();
  });

  it('does not count disabled effects toward the pass budget', () => {
    const doc = makeDocument([
      video('a', 0, 400, {
        effects: [
          { id: effectInstanceId('fx1'), effect: effectId('a'), enabled: true, params: {} },
          { id: effectInstanceId('fx2'), effect: effectId('b'), enabled: false, params: {} },
        ],
      }),
    ]);
    renderTimeline({ document: doc });
    expect(screen.getByText('fx 1')).toBeDefined();
  });

  it('conveys provenance and effect count in the accessible name, not only in colour', () => {
    const clip = video('made', 0, 100, {
      provenance: {
        generator: generatorId('t2v'),
        run: jobRunId('r1'),
        createdAt: '2026-08-08T00:00:00.000Z',
      },
      effects: [{ id: effectInstanceId('fx1'), effect: effectId('a'), enabled: true, params: {} }],
    });
    expect(clipAccessibleLabel(clip)).toBe('made, generated, 1 effect');
  });

  it('names a disabled clip as disabled', () => {
    expect(clipAccessibleLabel(video('a', 0, 100, { enabled: false }))).toContain('disabled');
  });
});

describe('selection', () => {
  it('reports a clip selection on pointer down', async () => {
    const user = userEvent.setup();
    const onSelectClip = vi.fn();
    renderTimeline({ onSelectClip });

    await user.click(screen.getByRole('button', { name: /^a$/ }));

    expect(onSelectClip).toHaveBeenCalledWith('a', false);
  });

  it('reports an additive selection when a modifier is held', async () => {
    const user = userEvent.setup();
    const onSelectClip = vi.fn();
    renderTimeline({ onSelectClip });

    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('button', { name: /^a$/ }));
    await user.keyboard('{/Shift}');

    expect(onSelectClip).toHaveBeenCalledWith('a', true);
  });

  it('marks the selected clip for assistive technology', () => {
    renderTimeline({ selectedClips: new Set(['a']) });
    const clip = document.querySelector('[data-clip-id="a"]');
    expect(clip?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('track controls', () => {
  it('exposes mute, solo and lock as pressable buttons per track', () => {
    renderTimeline();
    expect(screen.getByRole('button', { name: 'Mute V1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Solo A1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Lock T1' })).toBeDefined();
  });

  it('reflects track state through aria-pressed, not only through a tint', () => {
    const doc = makeDocument([]);
    const muted: TimelineDocument = {
      ...doc,
      sequence: {
        ...doc.sequence,
        tracks: doc.sequence.tracks.map((track) => (track.id === 'v1' ? { ...track, muted: true } : track)),
      },
    };
    renderTimeline({ document: muted });
    expect(screen.getByRole('button', { name: 'Mute V1' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Solo V1' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('reports track toggles', async () => {
    const user = userEvent.setup();
    const onTrackMute = vi.fn();
    renderTimeline({ onTrackMute });
    await user.click(screen.getByRole('button', { name: 'Mute V1' }));
    expect(onTrackMute).toHaveBeenCalledWith('v1');
  });
});

describe('toolbar', () => {
  it('shows snap as pressed when enabled', () => {
    renderTimeline({ snapEnabled: true });
    expect(screen.getByRole('button', { name: /Snap/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows ripple as unpressed when disabled', () => {
    // Stated rather than merely absent: "off" is a real state of a mode that changes what Delete does,
    // and a control that reports nothing when off tells a screen reader nothing about it.
    renderTimeline({ rippleEnabled: false });
    expect(screen.getByRole('button', { name: 'Ripple' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('reports toggles', async () => {
    const user = userEvent.setup();
    const onToggleSnap = vi.fn();
    const onToggleRipple = vi.fn();
    renderTimeline({ onToggleSnap, onToggleRipple });

    await user.click(screen.getByRole('button', { name: /Snap/ }));
    await user.click(screen.getByRole('button', { name: 'Ripple' }));

    expect(onToggleSnap).toHaveBeenCalled();
    expect(onToggleRipple).toHaveBeenCalled();
  });
});

describe('ruler', () => {
  it('is exposed as a slider for the playhead', () => {
    renderTimeline();
    expect(screen.getByRole('slider', { name: 'Playhead position' })).toBeDefined();
  });

  it('renders labelled ticks', () => {
    renderTimeline();
    expect(screen.getByText('00:00')).toBeDefined();
  });
});

describe('the marquee', () => {
  /** The lane container: the element a background pointer-down has to land on. */
  function laneArea(): HTMLElement {
    const lane = document.querySelector('[data-track-id]') as HTMLElement;
    return lane.parentElement as HTMLElement;
  }

  it('draws nothing until a drag starts', () => {
    renderTimeline({ onSelectRegion: vi.fn() });
    expect(document.querySelector('[data-marquee]')).toBeNull();
  });

  it('draws a rectangle while dragging the background', () => {
    renderTimeline({ onSelectRegion: vi.fn() });
    const area = laneArea();
    fireEvent.pointerDown(area, { button: 0, clientX: 100, clientY: 100 });

    expect(document.querySelector('[data-marquee]')).not.toBeNull();
  });

  it('does not start on a clip, which is a move gesture', () => {
    renderTimeline({ onSelectRegion: vi.fn() });
    const clip = document.querySelector('[data-clip-id="a"]') as HTMLElement;
    fireEvent.pointerDown(clip, { button: 0, clientX: 100, clientY: 100 });

    expect(document.querySelector('[data-marquee]')).toBeNull();
  });

  it('treats a click as a click, not as an empty selection', () => {
    // Otherwise tapping the background to focus the timeline would clear the selection every time.
    const onSelectRegion = vi.fn();
    renderTimeline({ onSelectRegion });

    const area = laneArea();
    fireEvent.pointerDown(area, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window);

    expect(onSelectRegion).not.toHaveBeenCalled();
  });

  it('clears the rectangle when the drag ends', () => {
    renderTimeline({ onSelectRegion: vi.fn() });
    const area = laneArea();
    fireEvent.pointerDown(area, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 60 });
    fireEvent.pointerUp(window);

    expect(document.querySelector('[data-marquee]')).toBeNull();
  });
});

describe('the snap indicator', () => {
  it('draws nothing when a drag has caught nothing', () => {
    renderTimeline();
    expect(document.querySelector('[data-snap-line]')).toBeNull();
  });

  it('draws a line where the drag snapped', () => {
    // 400 frames at 4 f/px is 100 px in.
    renderTimeline({ snapIndicator: { frame: frameIndex(400), kind: 'clip-end' } });
    const line = document.querySelector('[data-snap-line]') as HTMLElement;

    expect(line.style.left).toBe('100px');
  });

  it('names what it caught, since a bare line does not say why the clip jumped', () => {
    renderTimeline({ snapIndicator: { frame: frameIndex(0), kind: 'playhead' } });
    expect(screen.getByText('playhead')).toBeDefined();
  });

  it('is not the playhead, which it may be sitting exactly on top of', () => {
    renderTimeline({ snapIndicator: { frame: frameIndex(400), kind: 'playhead' } });
    const line = document.querySelector('[data-snap-line]') as HTMLElement;

    expect(line.className).toContain('border-dashed');
  });
});

describe('where a drop lands', () => {
  // Tested directly: jsdom has no `DragEvent`, so a drop cannot be dispatched at a React handler
  // there. What is left in the component is reading the payload and calling this.
  const viewport = createViewport({ framesPerPixel: 4, widthPx: 1000, frameRate: FRAME_RATES.WEB_30 });
  const tracks = makeDocument([]).sequence.tracks;

  it('lands on the track under the pointer, not the first one', () => {
    // Material goes where it was put, which is the whole reason to drag rather than double-click.
    expect(assetDropTarget(tracks, viewport, { x: 0, y: 100 })?.track).toBe('a1');
  });

  it('lands on the first track when the pointer is in it', () => {
    expect(assetDropTarget(tracks, viewport, { x: 0, y: 10 })?.track).toBe('v1');
  });

  it('converts the horizontal offset to a frame', () => {
    expect(assetDropTarget(tracks, viewport, { x: 100, y: 10 })?.frame).toBe(400);
  });

  it('clamps a drop left of the start rather than refusing it', () => {
    expect(assetDropTarget(tracks, viewport, { x: -50, y: 10 })?.frame).toBe(0);
  });

  it('reports nothing below the last track', () => {
    // Guessing the nearest row would put material where the user was not pointing.
    expect(assetDropTarget(tracks, viewport, { x: 0, y: 10_000 })).toBeUndefined();
  });
});

describe('what a rectangle covers', () => {
  // The geometry, tested directly: jsdom gives every element a zero-sized box and drops the
  // coordinates from a synthetic pointer event, so the gesture tests above can assert that a
  // rectangle appears but not where it landed.
  const viewport = createViewport({ framesPerPixel: 4, widthPx: 1000, frameRate: FRAME_RATES.WEB_30 });
  const tracks = makeDocument([]).sequence.tracks;

  it('converts pixels to the frames they cover', () => {
    const region = regionFor(viewport, tracks, { left: 100, top: 0, width: 50, height: 10 });
    expect(region.span.start).toBe(400);
    expect(region.span.start + region.span.duration).toBe(601);
  });

  it('covers every track the rectangle crosses', () => {
    // 84 + 60 tall: a rectangle from 0 to 100 crosses the video track and reaches into the audio.
    const region = regionFor(viewport, tracks, { left: 0, top: 0, width: 10, height: 100 });
    expect(region.tracks).toEqual(['v1', 'a1']);
  });

  it('covers only the track it stayed inside', () => {
    const region = regionFor(viewport, tracks, { left: 0, top: 10, width: 10, height: 20 });
    expect(region.tracks).toEqual(['v1']);
  });

  it('always covers at least one frame, so a thin drag still selects', () => {
    const region = regionFor(viewport, tracks, { left: 40, top: 0, width: 0, height: 40 });
    expect(region.span.duration).toBeGreaterThan(0);
  });

  it('never reports a frame before the start of the timeline', () => {
    const region = regionFor(viewport, tracks, { left: -200, top: 0, width: 10, height: 40 });
    expect(region.span.start).toBe(0);
  });
});

describe('many tracks', () => {
  it('scrolls the tracks rather than hiding them', () => {
    // The toolbar's own + V/A/T buttons make it easy to have more tracks than fit; before this the
    // area was a fixed height with overflow hidden, so the rest were invisible and unreachable.
    renderTimeline();
    const lane = document.querySelector('[data-track-id]') as HTMLElement;
    const scroller = lane.closest('[class*="overflow-y-auto"]') as HTMLElement | null;

    expect(scroller).not.toBeNull();
    // The headers scroll with the lanes rather than beside them: two scrollers kept in sync by hand
    // drift the moment either is scrolled by anything but a wheel.
    expect(scroller?.contains(document.querySelector('[data-track-header]'))).toBe(true);
  });

  it('measures the ruler against the very column the clips are drawn in', () => {
    // The invariant behind a reported misalignment. While the ruler sat in a row of its own above the
    // scroller, the two columns were free to be different widths — and the moment enough tracks
    // brought up a scrollbar they were, so every tick pointed a scrollbar's width away from the frame
    // it named. There is no arithmetic that fixes that, only one column instead of two; jsdom has no
    // layout to measure, so what is asserted is the structure that makes the widths the same object.
    renderTimeline();
    const ruler = screen.getByRole('slider', { name: 'Playhead position' });
    const lane = document.querySelector('[data-track-id]') as HTMLElement;

    const column = ruler.closest('[data-lane-column]');
    expect(column).not.toBeNull();
    expect(lane.closest('[data-lane-column]')).toBe(column);
    expect(ruler.contains(lane)).toBe(false);
  });

  it('renders exactly one ruler', () => {
    // Cheap, and it is the shape the misalignment took while the move was half-done: a second ruler
    // scrolled with the tracks under the pinned one, which reads as the ticks sliding.
    renderTimeline();
    expect(screen.getAllByRole('slider', { name: 'Playhead position' })).toHaveLength(1);
  });
});

/*
 * The drop indicator's *plumbing* is not tested here, deliberately.
 *
 * jsdom has no `DragEvent`, so a synthetic `dragover` carries no `dataTransfer` and the handler
 * returns before it can compute anything — a test driving it would assert that nothing happened and
 * pass for the wrong reason, which is worse than no test. The decision it plumbs is
 * `assetDropTarget`, exercised directly above: which track a point falls on, which frame, and the
 * refusal below the last track. What is left in the component is one call and one piece of state.
 */

describe('which edges are cuts', () => {
  // What makes rolling possible, and what the handle's tooltip promises. The affordance and the edit
  // must agree about which edges are cuts, or the tooltip offers a gesture that refuses.
  const track = (clips: readonly Clip[]) =>
    ({ ...(makeDocument(clips).sequence.tracks[0] as VideoTrack) }) as unknown as Parameters<
      typeof flushBefore
    >[0];

  it('is a cut where one clip ends and the next begins', () => {
    const clips = [video('a', 0, 100), video('b', 100, 200)];
    const t = track(clips);
    expect(flushAfter(t, clips[0] as Clip)).toBe(true);
    expect(flushBefore(t, clips[1] as Clip)).toBe(true);
  });

  it('is not a cut across a gap', () => {
    const clips = [video('a', 0, 100), video('b', 150, 250)];
    const t = track(clips);
    expect(flushAfter(t, clips[0] as Clip)).toBe(false);
    expect(flushBefore(t, clips[1] as Clip)).toBe(false);
  });

  it('is not a cut at the ends of the sequence', () => {
    const clips = [video('a', 0, 100), video('b', 100, 200)];
    const t = track(clips);
    expect(flushBefore(t, clips[0] as Clip)).toBe(false);
    expect(flushAfter(t, clips[1] as Clip)).toBe(false);
  });

  it('never counts a clip against itself', () => {
    // A zero-length clip cannot exist, but a rule comparing a clip's end to its own start would
    // report every clip as flush with itself and offer a roll against nothing.
    const clips = [video('only', 0, 100)];
    const t = track(clips);
    expect(flushBefore(t, clips[0] as Clip)).toBe(false);
    expect(flushAfter(t, clips[0] as Clip)).toBe(false);
  });

  it('marks the handle so the gesture can be found', () => {
    renderTimeline({
      document: makeDocument([video('a', 0, 300), video('b', 300, 600)]),
      onTrimStart: vi.fn(),
      onTrimEnd: vi.fn(),
    });

    const shared = document.querySelector('[data-clip-id="b"] [data-trim-handle="start"]');
    const outer = document.querySelector('[data-clip-id="a"] [data-trim-handle="start"]');
    expect(shared?.getAttribute('data-rollable')).toBe('');
    expect(outer?.hasAttribute('data-rollable')).toBe(false);
    expect(shared?.getAttribute('title')).toContain('Shift');
  });
});

describe('the context menu', () => {
  /**
   * A binding whose only item is `do-it`, so a test can open the menu, choose it, and read back which
   * target the choice was reported against. That target is the whole contract: everything else about
   * the menu — where it appears, how it closes — belongs to `ActionMenu` and to Base UI.
   */
  function binding() {
    const onChoose = vi.fn();
    return { menu: { items: () => [{ id: 'do-it', label: 'Do it' }], onChoose }, onChoose };
  }

  const choose = async () => {
    await userEvent.click(screen.getByRole('menuitem', { name: 'Do it' }));
  };

  it('is about the lane when the right-click was on empty track area', async () => {
    // Without it a menu opened over a lane could only offer clip actions — which is what the report
    // "I cannot create a track" was actually about.
    const { menu, onChoose } = binding();
    renderTimeline({ menu });

    fireEvent.contextMenu(document.querySelector('[data-track-id="v1"]') as HTMLElement);
    await choose();

    expect(onChoose).toHaveBeenCalledWith({ track: 'v1' }, 'do-it');
  });

  it('is about the clip and its lane when the click was on a clip', async () => {
    const { menu, onChoose } = binding();
    renderTimeline({ menu });

    fireEvent.contextMenu(screen.getByRole('button', { name: /^a$/ }));
    await choose();

    expect(onChoose).toHaveBeenCalledWith({ clip: 'a', track: 'v1' }, 'do-it');
  });

  it('is about nothing at all below the last track', async () => {
    // A distinct case rather than an omission: it is what makes "add a track" reachable in a sequence
    // whose tracks the pointer is nowhere near.
    const { menu, onChoose } = binding();
    renderTimeline({ menu });

    fireEvent.contextMenu(document.querySelector('[data-lane-surface]') as HTMLElement);
    await choose();

    expect(onChoose).toHaveBeenCalledWith({}, 'do-it');
  });

  it('opens exactly one menu for a click on a clip', async () => {
    // A clip sits inside a lane which sits inside the surface, and all three offer a menu. Only the
    // innermost may answer, or a click plainly on a clip would report the lane behind it.
    const { menu, onChoose } = binding();
    renderTimeline({ menu });

    fireEvent.contextMenu(screen.getByRole('button', { name: /^a$/ }));
    expect(screen.getAllByRole('menuitem', { name: 'Do it' })).toHaveLength(1);

    await choose();
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});

describe('renaming a track from elsewhere', () => {
  it('opens the same field a double-click opens', () => {
    // Two ways to rename that behaved differently would be worse than one.
    renderTimeline({ onTrackRename: vi.fn(), renamingTrack: trackId('v1') });
    expect(screen.getByLabelText('Rename V1')).toBeDefined();
  });

  it('leaves every other track alone', () => {
    renderTimeline({ onTrackRename: vi.fn(), renamingTrack: trackId('v1') });
    expect(screen.queryByLabelText('Rename A1')).toBeNull();
  });
});

describe('resizing a track', () => {
  it('offers a grip only when something can handle it', () => {
    renderTimeline();
    expect(screen.queryByLabelText('Resize V1')).toBeNull();
  });

  it('reports while the drag is in flight, not only on release', () => {
    // A row that only resized when the pointer came up would be adjusted by trial and error. The
    // height itself is arithmetic on coordinates jsdom does not carry; what is asserted is the phase,
    // and `setTrackHeight` covers the clamping.
    const onTrackResize = vi.fn();
    renderTimeline({ onTrackResize });

    const grip = screen.getByLabelText('Resize V1');
    fireEvent.pointerDown(grip, { pointerId: 1 });
    fireEvent.pointerMove(grip, { pointerId: 1 });

    expect(onTrackResize.mock.calls.at(-1)?.[2]).toBe('move');
  });

  it('closes the gesture when the pointer comes up, so a drag is one undo step', () => {
    const onTrackResize = vi.fn();
    renderTimeline({ onTrackResize });

    const grip = screen.getByLabelText('Resize V1');
    fireEvent.pointerDown(grip, { pointerId: 1 });
    fireEvent.pointerUp(grip, { pointerId: 1 });

    expect(onTrackResize.mock.calls.at(-1)?.[2]).toBe('end');
  });

  it('reports nothing at all without a drag having started', () => {
    const onTrackResize = vi.fn();
    renderTimeline({ onTrackResize });

    fireEvent.pointerMove(screen.getByLabelText('Resize V1'), { pointerId: 1 });
    expect(onTrackResize).not.toHaveBeenCalled();
  });

  it('does not start a marquee or a scrub', () => {
    // The grip sits on a header, but a stray gesture reaching the lanes would be worse than useless.
    const onSelectRegion = vi.fn();
    renderTimeline({ onTrackResize: vi.fn(), onSelectRegion });

    fireEvent.pointerDown(screen.getByLabelText('Resize V1'), { clientY: 100, pointerId: 1 });
    expect(onSelectRegion).not.toHaveBeenCalled();
  });
});

describe('renaming a track', () => {
  it('is a label until asked, so the header keeps its width for controls', () => {
    renderTimeline({ onTrackRename: vi.fn() });
    expect(screen.queryByLabelText('Rename V1')).toBeNull();
  });

  it('becomes a field on double-click', () => {
    renderTimeline({ onTrackRename: vi.fn() });
    fireEvent.doubleClick(screen.getByTitle('V1 — double-click to rename'));

    expect(screen.getByLabelText('Rename V1')).toBeDefined();
  });

  it('commits on enter', () => {
    const onTrackRename = vi.fn();
    renderTimeline({ onTrackRename });

    fireEvent.doubleClick(screen.getByTitle('V1 — double-click to rename'));
    const field = screen.getByLabelText('Rename V1');
    fireEvent.change(field, { target: { value: 'V1 · b-roll' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onTrackRename).toHaveBeenCalledWith('v1', 'V1 · b-roll');
  });

  it('abandons on escape, so a mistyped name is not committed by looking away', () => {
    const onTrackRename = vi.fn();
    renderTimeline({ onTrackRename });

    fireEvent.doubleClick(screen.getByTitle('V1 — double-click to rename'));
    const field = screen.getByLabelText('Rename V1');
    fireEvent.change(field, { target: { value: 'oops' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(onTrackRename).not.toHaveBeenCalled();
  });

  it('stays a label when nothing can accept a rename', () => {
    renderTimeline();
    fireEvent.doubleClick(screen.getByTitle('V1'));
    expect(screen.queryByLabelText('Rename V1')).toBeNull();
  });
});

describe('opening a clip', () => {
  const animated = (id: string) =>
    video(id, 0, 300, {
      transform: {
        ...transform,
        opacity: {
          kind: 'animated',
          keyframes: [
            { id: 'k0', frame: 0, value: 1, ease: 'linear' },
            { id: 'k1', frame: 100, value: 0, ease: 'linear' },
          ],
        },
      },
    } as Partial<Clip>);

  it('offers a disclosure only on a clip with something to show', () => {
    // An empty disclosure punishes the user for using it.
    const doc = makeDocument([animated('moving'), video('still', 400, 700)]);
    renderTimeline({ document: doc, onToggleExpandClip: vi.fn() });

    expect(document.querySelector('[data-clip-disclosure="moving"]')).not.toBeNull();
    expect(document.querySelector('[data-clip-disclosure="still"]')).toBeNull();
  });

  it('offers none at all when nothing can open a clip', () => {
    renderTimeline({ document: makeDocument([animated('moving')]) });
    expect(document.querySelector('[data-clip-disclosure]')).toBeNull();
  });

  it('reports the toggle rather than performing it', () => {
    const onToggleExpandClip = vi.fn();
    renderTimeline({ document: makeDocument([animated('moving')]), onToggleExpandClip });

    (document.querySelector('[data-clip-disclosure="moving"]') as HTMLElement).click();
    expect(onToggleExpandClip).toHaveBeenCalledWith('moving');
  });

  it('draws the lanes under the clip´s own track, not at the foot of the panel', () => {
    // A lane is read against the clip it belongs to; one drawn three tracks away has to be
    // correlated by eye.
    const doc = makeDocument([animated('moving')]);
    renderTimeline({
      document: doc,
      expandedClip: clipId('moving'),
      lanes: <div data-testid="lanes" />,
    });

    const lanes = document.querySelector('[data-clip-lanes="moving"]');
    const videoLane = document.querySelector('[data-track-id="v1"]');
    const audioLane = document.querySelector('[data-track-id="a1"]');

    expect(lanes).not.toBeNull();
    expect(videoLane!.compareDocumentPosition(lanes!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lanes!.compareDocumentPosition(audioLane!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws nothing when no clip is open', () => {
    renderTimeline({ document: makeDocument([animated('moving')]), lanes: <div /> });
    expect(document.querySelector('[data-clip-lanes]')).toBeNull();
  });

  it('marks the open clip for assistive technology', () => {
    const doc = makeDocument([animated('moving')]);
    renderTimeline({ document: doc, expandedClip: clipId('moving'), onToggleExpandClip: vi.fn() });

    const button = document.querySelector('[data-clip-disclosure="moving"]');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not start a drag when the disclosure is used', () => {
    // The disclosure sits on a clip body whose pointer-down begins a move gesture.
    const onClipPointerDown = vi.fn();
    renderTimeline({
      document: makeDocument([animated('moving')]),
      onToggleExpandClip: vi.fn(),
      onClipPointerDown,
    });

    const button = document.querySelector('[data-clip-disclosure="moving"]') as HTMLElement;
    fireEvent.pointerDown(button, { bubbles: true });

    expect(onClipPointerDown).not.toHaveBeenCalled();
  });
});

describe('tracks', () => {
  it('offers a button per kind, because which one is wanted is not derivable', () => {
    const onAddTrack = vi.fn();
    renderTimeline({ onAddTrack });

    screen.getByTitle('Add an audio track').click();
    expect(onAddTrack).toHaveBeenCalledWith('audio');
  });

  it('offers no add buttons when nothing can handle them', () => {
    renderTimeline();
    expect(screen.queryByTitle('Add a video track')).toBeNull();
  });

  it('reports a removal rather than performing one', () => {
    const onTrackRemove = vi.fn();
    renderTimeline({ onTrackRemove });

    screen.getByLabelText('Remove V1 and everything on it').click();
    expect(onTrackRemove).toHaveBeenCalledWith('v1');
  });

  it('disables removal on a locked track rather than hiding it', () => {
    // A control that vanishes leaves the user hunting for it; a disabled one explains itself.
    const base = makeDocument([video('a', 0, 300)]);
    const locked = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) => (track.id === 'v1' ? { ...track, locked: true } : track)),
      },
    } as TimelineDocument;

    renderTimeline({ document: locked, onTrackRemove: vi.fn() });
    const button = screen.getByLabelText('V1 is locked — unlock it to remove it');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what removal costs in the control´s own name', () => {
    renderTimeline({ onTrackRemove: vi.fn() });
    expect(screen.getByLabelText('Remove A1 and everything on it')).toBeDefined();
  });
});

describe('strips', () => {
  function stripImage(clip: string): HTMLImageElement | null {
    return document.querySelector(`[data-clip-id="${clip}"] img`);
  }

  it('draws nothing until a derivation arrives', () => {
    renderTimeline();
    expect(stripImage('a')).toBeNull();
  });

  it('places an asset-wide filmstrip against the range the clip shows', () => {
    // A strip five clip-widths long, starting two widths before the clip: the numbers the placement
    // model produced have to survive the trip into CSS, or the pictures land under the wrong frames.
    renderTimeline({
      strips: new Map([['a', { url: 'file:strip.jpg', widths: 5, offset: 2 }]]),
    });

    const image = stripImage('a');
    expect(image?.getAttribute('src')).toBe('file:strip.jpg');
    expect(image?.style.width).toBe('500%');
    expect(image?.style.left).toBe('-200%');
  });

  it('clips the overhang, so a strip stays inside its clip', () => {
    renderTimeline({
      strips: new Map([['a', { url: 'file:strip.jpg', widths: 5, offset: 2 }]]),
    });
    const layer = document.querySelector('[data-clip-id="a"] [data-strip-kind]');
    expect((layer as HTMLElement | null)?.className).toContain('overflow-hidden');
  });

  it('gives a waveform the whole clip and a filmstrip a band', () => {
    // Different jobs: a waveform *is* the clip's content, a filmstrip sits under a label that has to
    // stay readable.
    const doc = makeDocument([video('a', 0, 300)]);
    const strips = new Map([['a', { url: 'file:strip.jpg', widths: 1, offset: 0 }]]);
    renderTimeline({ document: doc, strips });

    const layer = document.querySelector('[data-clip-id="a"] [data-strip-kind]') as HTMLElement;
    expect(layer.dataset['stripKind']).toBe('filmstrip');
    // A band, not the whole clip: `h-8` against the audio case's `h-full`.
    expect(layer.className).toContain('h-8');
    expect(layer.className).not.toContain('h-full');
  });

  it('keeps the label above the strip', () => {
    // A full-height waveform painted last would cover the one thing that names the clip.
    renderTimeline({
      strips: new Map([['a', { url: 'file:strip.jpg', widths: 1, offset: 0 }]]),
    });

    const clip = document.querySelector('[data-clip-id="a"]') as HTMLElement;
    const children = [...clip.children];
    const strip = children.findIndex((node) => node.hasAttribute('data-strip-kind'));
    const label = children.findIndex((node) => node.textContent?.includes('a'));
    expect(strip).toBeLessThan(label);
  });

  it('leaves a strip out of the accessibility tree', () => {
    // It carries no information a screen reader can use, and an unlabelled image in every clip would
    // be noise between the clip's own name and its controls.
    renderTimeline({
      strips: new Map([['a', { url: 'file:strip.jpg', widths: 1, offset: 0 }]]),
    });
    expect(stripImage('a')?.getAttribute('alt')).toBe('');
  });
});

describe('in/out range', () => {
  function ranged(from: number, to: number) {
    const base = makeDocument([video('a', 0, 300)]);
    return {
      ...base,
      sequence: { ...base.sequence, workRange: spanFromBounds(frameIndex(from), frameIndex(to)) },
    };
  }

  it('draws nothing on the ruler when no range is marked', () => {
    renderTimeline();
    expect(document.querySelector('[data-work-range]')).toBeNull();
  });

  it('draws the range where it sits', () => {
    // At 4 f/px, frames 100..200 start at 25 px and run 25 px wide.
    renderTimeline({ document: ranged(100, 200) });
    const bar = document.querySelector('[data-work-range]') as HTMLElement;
    expect(bar.style.left).toBe('25px');
    expect(bar.style.width).toBe('25px');
  });

  it('states the range in numbers as well as drawing it', () => {
    // A four-pixel bar is easy to miss, and an export that silently covers part of the sequence is
    // the failure that costs the most to discover afterwards.
    renderTimeline({ document: ranged(100, 200), onMarkIn: vi.fn() });
    expect(screen.getByText('100–199')).toBeDefined();
  });

  it('offers the marks only when something can handle them', () => {
    renderTimeline();
    expect(screen.queryByText('Mark in')).toBeNull();
  });

  it('reports a mark rather than performing one', () => {
    // The timeline never mutates: every edit goes through the editing layer and the store, which is
    // what keeps undo and autosave uniform.
    const onMarkIn = vi.fn();
    const onMarkOut = vi.fn();
    renderTimeline({ onMarkIn, onMarkOut });

    screen.getByText('Mark in').click();
    screen.getByText('Mark out').click();
    expect(onMarkIn).toHaveBeenCalledTimes(1);
    expect(onMarkOut).toHaveBeenCalledTimes(1);
  });

  it('offers Clear only when there is a range to clear', () => {
    renderTimeline({ onMarkIn: vi.fn() });
    expect(screen.queryByText('Clear')).toBeNull();

    cleanup();
    renderTimeline({ document: ranged(10, 20), onMarkIn: vi.fn() });
    expect(screen.getByText('Clear')).toBeDefined();
  });
});

describe('markers', () => {
  function withMarkers(frames: readonly number[]) {
    const base = makeDocument([video('a', 0, 300)]);
    return {
      ...base,
      sequence: {
        ...base.sequence,
        markers: frames.map((frame) => ({ frame: frameIndex(frame), label: `m${frame}` })),
      },
    };
  }

  it('draws one flag per marker', () => {
    renderTimeline({ document: withMarkers([40, 120]) });
    expect(document.querySelectorAll('[data-marker-frame]')).toHaveLength(2);
  });

  it('places a flag at its frame', () => {
    renderTimeline({ document: withMarkers([120]) });
    const flag = document.querySelector('[data-marker-frame="120"]') as HTMLElement;
    // 120 frames at 4 f/px is 30 px, less half the flag's width so it points at the frame.
    expect(flag.style.left).toBe('27px');
  });

  it('seeks when clicked, because the only thing to do with a place is go to it', () => {
    const onScrub = vi.fn();
    renderTimeline({ document: withMarkers([120]), onScrub });

    (document.querySelector('[data-marker-frame="120"]') as HTMLElement).click();
    expect(onScrub).toHaveBeenCalledWith(120);
  });

  it('names the frame it marks, for anyone not looking at the ruler', () => {
    renderTimeline({ document: withMarkers([120]) });
    expect(screen.getByLabelText('Marker m120 at frame 120')).toBeDefined();
  });
});

describe('trim handles', () => {
  it('renders grab areas at both edges of a wide clip', () => {
    renderTimeline();
    const clip = document.querySelector('[data-clip-id="a"]');
    expect(clip?.querySelector('[data-trim-handle="start"]')).not.toBeNull();
    expect(clip?.querySelector('[data-trim-handle="end"]')).not.toBeNull();
  });

  it('omits handles on a clip too narrow to grab them', () => {
    // At 4 f/px an 8-frame clip is 2 px wide; handles would cover it entirely and make moving
    // impossible.
    const doc = makeDocument([video('tiny', 0, 8)]);
    renderTimeline({ document: doc });
    const clip = document.querySelector('[data-clip-id="tiny"]');
    expect(clip?.querySelector('[data-trim-handle="start"]')).toBeNull();
  });
});

/**
 * Fade handles and ramps.
 *
 * A fade is the one edit whose *result* is invisible on the timeline — a clip that ramps in over
 * twenty frames looks exactly like one that does not — so the wedge is not decoration, it is the
 * confirmation that a drop created a crossfade rather than being allowed by mistake.
 */
describe('fades', () => {
  const faded = () => makeDocument([video('a', 0, 300, { fade: { inFrames: 60, outFrames: 30 } })]);

  it('draws a wedge for each ramp, sized from the clip’s own proportions', () => {
    renderTimeline({ document: faded() });
    const clip = document.querySelector('[data-clip-id="a"]');
    const rampIn = clip?.querySelector('[data-fade-ramp="in"]') as HTMLElement | null;
    // 300 frames across 75 px at 4 f/px, so 60 frames of ramp is a fifth of it.
    expect(rampIn?.style.width).toBe('15px');
    expect((clip?.querySelector('[data-fade-ramp="out"]') as HTMLElement | null)?.style.width).toBe('7.5px');
  });

  it('draws no wedge where there is no ramp', () => {
    renderTimeline();
    const clip = document.querySelector('[data-clip-id="a"]');
    expect(clip?.querySelector('[data-fade-ramp="in"]')).toBeNull();
  });

  it('offers a handle at each corner even with no fade, so one can be found at all', () => {
    // A control that appears only once the thing it controls exists can be found only by someone who
    // already knows it is there.
    renderTimeline({ onFadeDrag: () => {} });
    const clip = document.querySelector('[data-clip-id="a"]');
    expect(clip?.querySelector('[data-fade-handle="in"]')).not.toBeNull();
    expect(clip?.querySelector('[data-fade-handle="out"]')).not.toBeNull();
  });

  it('leaves the handles off when nothing can act on them', () => {
    renderTimeline();
    expect(document.querySelector('[data-fade-handle="in"]')).toBeNull();
  });

  it('names the ramp’s length on the handle, for anyone not reading the wedge', () => {
    renderTimeline({ document: faded(), onFadeDrag: () => {} });
    const handle = document.querySelector('[data-clip-id="a"] [data-fade-handle="in"]');
    expect(handle?.getAttribute('aria-label')).toBe('Fade in a, 60 frames');
  });

  it('omits handles on a clip too narrow to hold them', () => {
    renderTimeline({ document: makeDocument([video('tiny', 0, 100)]), onFadeDrag: () => {} });
    expect(document.querySelector('[data-fade-handle="in"]')).toBeNull();
  });
});

/**
 * Collapsing a track.
 *
 * `Track.collapsed` was in the document model, defaulted, serialized and round-tripped — and nothing
 * ever wrote or read it. A track could be collapsed in the file format and not in the application.
 *
 * A view state, not an edit: the height is kept, the clips stay, and a locked track collapses like any
 * other because collapsing disturbs nothing on it.
 */
describe('collapsing a track', () => {
  function collapsedDocument(): TimelineDocument {
    const base = makeDocument([video('a', 0, 300)]);
    const tracks = base.sequence.tracks.map((track, index) =>
      index === 0 ? ({ ...track, collapsed: true } as typeof track) : track,
    );
    return { ...base, sequence: { ...base.sequence, tracks } };
  }

  const laneOf = (id: string): HTMLElement | null =>
    document.querySelector(`[data-track-id="${id}"]`) as HTMLElement | null;

  it('draws the lane as a strip', () => {
    renderTimeline({ document: collapsedDocument() });
    expect(laneOf('v1')?.style.height).toBe(`${COLLAPSED_TRACK_HEIGHT_PX}px`);
  });

  it('leaves the other lanes alone', () => {
    // Collapsing one row must not move or resize the rest; only its own height changes.
    const doc = collapsedDocument();
    renderTimeline({ document: doc });
    const audio = doc.sequence.tracks[1]!;
    expect(laneOf('a1')?.style.height).toBe(`${audio.height}px`);
  });

  it('keeps the clips on it, because the question is where the material is', () => {
    renderTimeline({ document: collapsedDocument() });
    expect(document.querySelectorAll('[data-clip-id]')).toHaveLength(1);
  });

  it('offers to expand a collapsed track and to collapse an open one', () => {
    // Labelled with what the click does, not the state it is in.
    renderTimeline({ document: collapsedDocument(), onTrackCollapse: vi.fn() });
    expect(screen.getByRole('button', { name: 'Expand V1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse A1' })).toBeTruthy();
  });

  it('reports the toggle rather than performing it', () => {
    // The same rule every control here follows: the document is the shell's to change.
    const onTrackCollapse = vi.fn();
    renderTimeline({ onTrackCollapse });
    screen.getByRole('button', { name: 'Collapse V1' }).click();
    expect(onTrackCollapse).toHaveBeenCalledWith('v1');
  });

  it('shows no disclosure at all when nothing can collapse a track', () => {
    renderTimeline();
    expect(screen.queryByRole('button', { name: 'Collapse V1' })).toBeNull();
  });

  it('draws its clips as bars, without labels there is no room for', () => {
    // A label clipped to three pixels of its ascenders is not a smaller label, it is noise over the
    // one thing that says which clip this is. The accessible name stays, so the clip is still findable.
    renderTimeline({ document: collapsedDocument() });
    const clip = document.querySelector('[data-clip-id="a"]') as HTMLElement;

    expect(clip.textContent).toBe('');
    expect(clip.getAttribute('aria-label')).toContain('a');
  });

  it('keeps the label when the lane is tall enough for one', () => {
    renderTimeline();
    expect((document.querySelector('[data-clip-id="a"]') as HTMLElement).textContent).not.toBe('');
  });

  it('drops the monitoring toggles from a collapsed header', () => {
    // A track that has been put away. The header's job is to say which one it is and offer to bring
    // it back; mute, solo, lock and delete are all still one right-click away.
    renderTimeline({ document: collapsedDocument(), onTrackCollapse: vi.fn() });
    expect(screen.queryByTitle('Mute V1')).toBeNull();
    expect(screen.getByTitle('Mute A1')).toBeTruthy();
  });

  it('still names a collapsed row, which is all that identifies it', () => {
    renderTimeline({ document: collapsedDocument(), onTrackCollapse: vi.fn() });
    expect(screen.getByText('V1')).toBeTruthy();
  });

  it('withdraws the resize grip while collapsed', () => {
    // It would set a height the lane is not drawing, so the row would refuse to follow the pointer.
    renderTimeline({ document: collapsedDocument(), onTrackResize: vi.fn() });
    expect(screen.queryByRole('separator', { name: 'Resize V1' })).toBeNull();
    expect(screen.getByRole('separator', { name: 'Resize A1' })).toBeTruthy();
  });
});

/**
 * Naming a marker.
 *
 * `Marker.label` and `Marker.color` were in the document model from the first commit, the ruler drew
 * both and `project.json` round-tripped both — and nothing could set either. Every marker was named
 * after its own timecode, which is the one fact the ruler it sits on already states.
 */
describe('markers', () => {
  const withMarkers = (): TimelineDocument => {
    const base = makeDocument([video('a', 0, 300)]);
    return {
      ...base,
      sequence: {
        ...base.sequence,
        markers: [{ frame: frameIndex(120), label: 'chorus' }],
      },
    };
  };

  const flag = () => screen.getByRole('button', { name: /^Marker chorus/ });

  it('seeks on a single click, because that is what a place is for', async () => {
    const onScrub = vi.fn();
    renderTimeline({ document: withMarkers(), onScrub });
    flag().click();
    expect(onScrub).toHaveBeenCalledWith(120);
  });

  it('stays a plain flag when nothing can edit it', async () => {
    const user = userEvent.setup();
    renderTimeline({ document: withMarkers() });
    await user.dblClick(flag());
    expect(screen.queryByRole('textbox', { name: /^Rename/ })).toBeNull();
  });

  it('opens on a double-click, since the flag is eight pixels wide', async () => {
    // A single click has to stay the cheap action.
    const user = userEvent.setup();
    renderTimeline({ document: withMarkers(), onEditMarker: vi.fn() });
    await user.dblClick(flag());
    expect(screen.getByRole('textbox', { name: 'Rename chorus' })).toBeTruthy();
  });

  it('renames on Enter', async () => {
    const user = userEvent.setup();
    const onEditMarker = vi.fn();
    renderTimeline({ document: withMarkers(), onEditMarker });

    await user.dblClick(flag());
    const field = screen.getByRole('textbox', { name: 'Rename chorus' });
    await user.clear(field);
    await user.type(field, 'fix this shot{Enter}');

    expect(onEditMarker).toHaveBeenCalledWith(120, { label: 'fix this shot' });
  });

  it('abandons the edit on Escape', async () => {
    const user = userEvent.setup();
    const onEditMarker = vi.fn();
    renderTimeline({ document: withMarkers(), onEditMarker });

    await user.dblClick(flag());
    await user.type(screen.getByRole('textbox', { name: 'Rename chorus' }), 'oops{Escape}');

    expect(onEditMarker).not.toHaveBeenCalled();
  });

  it('colours it with a theme role rather than a literal', async () => {
    // Stored as the variable, so a marker keeps following the palette and dark mode after it is set.
    const user = userEvent.setup();
    const onEditMarker = vi.fn();
    renderTimeline({ document: withMarkers(), onEditMarker });

    await user.dblClick(flag());
    await user.click(screen.getByRole('button', { name: 'Colour var(--chart-2)' }));

    expect(onEditMarker).toHaveBeenCalledWith(120, { color: 'var(--chart-2)' });
  });

  it('clears the colour back to the default', async () => {
    const user = userEvent.setup();
    const onEditMarker = vi.fn();
    renderTimeline({ document: withMarkers(), onEditMarker });

    await user.dblClick(flag());
    await user.click(screen.getByRole('button', { name: 'Default colour' }));

    expect(onEditMarker).toHaveBeenCalledWith(120, { color: null });
  });

  it('removes it', async () => {
    const user = userEvent.setup();
    const onRemoveMarker = vi.fn();
    renderTimeline({ document: withMarkers(), onEditMarker: vi.fn(), onRemoveMarker });

    await user.dblClick(flag());
    await user.click(screen.getByRole('button', { name: 'Remove chorus' }));

    expect(onRemoveMarker).toHaveBeenCalledWith(120);
  });
});

/**
 * Scrub audio.
 *
 * §6.2 asks for "audio mix **and scrub**". The engine could play a short grain at a frame from the
 * day it was written and nothing ever called it, so dragging the playhead was silent — and the toggle
 * exists because scrub audio is also the first thing some editors turn off.
 */
describe('the scrub audio toggle', () => {
  it('is left out entirely when nothing can toggle it', () => {
    // A dead control teaches the user that the others might be dead too.
    renderTimeline();
    expect(screen.queryByRole('button', { name: /Scrub/ })).toBeNull();
  });

  it('says which way it is set, not just that it exists', () => {
    renderTimeline({ scrubAudioEnabled: true, onToggleScrubAudio: vi.fn() });
    expect(screen.getByTitle(/dragging the playhead plays what is under it/)).toBeTruthy();

    cleanup();
    renderTimeline({ scrubAudioEnabled: false, onToggleScrubAudio: vi.fn() });
    expect(screen.getByTitle(/dragging the playhead is silent/)).toBeTruthy();
  });

  it('reports the toggle rather than performing it', () => {
    const onToggleScrubAudio = vi.fn();
    renderTimeline({ scrubAudioEnabled: true, onToggleScrubAudio });
    screen.getByRole('button', { name: /Scrub/ }).click();
    expect(onToggleScrubAudio).toHaveBeenCalled();
  });
});
