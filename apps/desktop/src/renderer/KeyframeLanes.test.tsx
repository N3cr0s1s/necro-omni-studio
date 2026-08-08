// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type Track,
  type VideoClip,
  FRAME_RATES,
  animatedNumber,
  assetPath,
  clipId,
  createDocument,
  effectId,
  effectInstanceId,
  frameIndex,
  isAnimated,
  keyframeId,
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import { createViewport } from '@nos/ui';
import { KeyframeLanes } from './KeyframeLanes.js';
import { createTextClip } from './TextInspector.js';

afterEach(cleanup);

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };
const effects = createEffectRegistry(BUILTIN_EFFECTS);

const viewport = createViewport({
  framesPerPixel: 1,
  scrollFrame: frameIndex(0),
  widthPx: 800,
  frameRate: FRAME_RATES.WEB_30,
});

/** Two markers, which is the fewest that makes a curve rather than a held value. */
const curve = (a: number, b: number) =>
  animatedNumber([
    { id: keyframeId('k0'), frame: frameIndex(0), value: a, ease: 'linear' },
    { id: keyframeId('k1'), frame: frameIndex(12), value: b, ease: 'ease-out' },
  ]);

function videoClip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    kind: 'video',
    id: clipId('c1'),
    span: spanFromBounds(frameIndex(0), frameIndex(120)),
    label: 'c1',
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/x.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
    ...overrides,
  };
}

function documentWith(clip: Clip, kind: 'video' | 'text' | 'audio' = 'video'): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'P',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === kind ? ({ ...track, clips: [clip] } as Track) : track,
      ),
    },
  };
}

const renderLanes = (document: TimelineDocument, clip = 'c1') => {
  const onChange = vi.fn();
  render(
    <KeyframeLanes
      document={document}
      clip={clip}
      effects={effects}
      viewport={viewport}
      playhead={frameIndex(0)}
      onChange={onChange}
    />,
  );
  return onChange;
};

/**
 * jsdom gives every element a zero-sized box, and the lane converts a click's x offset into a frame.
 * Stating the box is what makes the conversion testable at all.
 */
function sized(element: HTMLElement): HTMLElement {
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 800,
      height: 34,
      right: 800,
      bottom: 34,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

/** The opacity curve as it is after a commit, so assertions read the document rather than a call shape. */
function animatedOpacityFrom(onChange: ReturnType<typeof vi.fn>) {
  const last = onChange.mock.calls.at(-1);
  if (last === undefined) throw new Error('nothing was committed');
  const located = locateClip(last[1] as TimelineDocument, 'c1' as never);
  if (located === undefined || located.clip.kind === 'audio') throw new Error('the clip is gone');

  const opacity = located.clip.transform.opacity;
  if (!isAnimated(opacity)) throw new Error('opacity is not animated');
  return opacity;
}

const markerFramesFrom = (onChange: ReturnType<typeof vi.fn>): readonly number[] =>
  animatedOpacityFrom(onChange).keyframes.map((keyframe) => keyframe.frame);

const laneLabels = (): readonly string[] =>
  [...window.document.querySelectorAll('[aria-label$="keyframes"]')].map(
    (lane) => lane.getAttribute('aria-label') ?? '',
  );

describe('which lanes appear', () => {
  it('shows none when nothing is animated', () => {
    // A lane per *possible* parameter would bury the two that are actually animated under a dozen that
    // are not.
    renderLanes(documentWith(videoClip()));
    expect(laneLabels()).toEqual([]);
  });

  it('shows a lane for an animated transform channel', () => {
    // This is what a text preset writes into, so without it a preset's output would be invisible and
    // the panel's promise that it is editable would be false.
    const clip = videoClip({
      transform: { ...videoClip().transform, opacity: curve(0, 1) },
    });
    renderLanes(documentWith(clip));

    expect(laneLabels()).toEqual(['transform · opacity keyframes']);
  });

  it('shows a lane for an animated effect parameter', () => {
    const clip = videoClip({
      effects: [
        {
          id: effectInstanceId('fx1'),
          effect: effectId('film_grain'),
          enabled: true,
          params: { amount: curve(0, 1) },
        },
      ],
    });
    renderLanes(documentWith(clip));

    expect(laneLabels()).toEqual(['Film Grain · amount keyframes']);
  });

  it('shows the reveal channel for a text clip, which is not a transform', () => {
    // Typewriter changes the number of visible glyphs. Folding it into the transform would make it
    // unreachable in the one place a user would look for it.
    const title = { ...createTextClip('c1', 0), reveal: curve(0, 1) };
    renderLanes(documentWith(title, 'text'));

    expect(laneLabels()).toEqual(['text · reveal keyframes']);
  });

  it('shows level and pan for an audio clip, which has no transform to hide them in', () => {
    // Without these an audio fade could be switched on in the inspector and never shaped, because an
    // audio clip has no transform and its gain is not an effect parameter.
    const clip = {
      kind: 'audio',
      id: clipId('c1'),
      span: spanFromBounds(frameIndex(0), frameIndex(300)),
      label: 'tone.flac',
      enabled: true,
      effects: [],
      source: {
        asset: assetPath('media/tone.flac'),
        sourceIn: frameIndex(0),
        sourceRate: FRAME_RATES.WEB_30,
      },
      speed: { factor: 1, preservePitch: true },
      gain: curve(1, 0),
      pan: curve(-1, 1),
    } as unknown as Clip;

    renderLanes(documentWith(clip, 'audio'));

    expect(laneLabels()).toEqual(['audio · gain keyframes', 'audio · pan keyframes']);
  });

  it('leaves a constant level alone, so a lane means something is animated', () => {
    const clip = {
      kind: 'audio',
      id: clipId('c1'),
      span: spanFromBounds(frameIndex(0), frameIndex(300)),
      label: 'tone.flac',
      enabled: true,
      effects: [],
      source: {
        asset: assetPath('media/tone.flac'),
        sourceIn: frameIndex(0),
        sourceRate: FRAME_RATES.WEB_30,
      },
      speed: { factor: 1, preservePitch: true },
      gain: staticNumber(1),
      pan: staticNumber(0),
    } as unknown as Clip;

    renderLanes(documentWith(clip, 'audio'));

    expect(laneLabels()).toEqual([]);
  });

  it('puts the clip´s own channels before its effects', () => {
    // A preset's markers are what a user reaches for immediately after applying one; an effect's are
    // something they went looking for.
    const clip = videoClip({
      transform: { ...videoClip().transform, y: curve(0, 1) },
      effects: [
        {
          id: effectInstanceId('fx1'),
          effect: effectId('film_grain'),
          enabled: true,
          params: { amount: curve(0, 1) },
        },
      ],
    });
    renderLanes(documentWith(clip));

    expect(laneLabels()).toEqual(['transform · y keyframes', 'Film Grain · amount keyframes']);
  });

  it('shows nothing when no clip is selected', () => {
    render(
      <KeyframeLanes
        document={documentWith(videoClip())}
        effects={effects}
        viewport={viewport}
        playhead={frameIndex(0)}
        onChange={vi.fn()}
      />,
    );
    expect(laneLabels()).toEqual([]);
  });
});

describe('editing markers', () => {
  const animated = () =>
    documentWith(videoClip({ transform: { ...videoClip().transform, opacity: curve(0, 1) } }));

  it('writes a typed value into the document, which nothing else could do', async () => {
    // The gap this closes: the inspector disables an animated parameter's slider, so before the lane
    // grew a field there was no control anywhere that could give a marker a number. A fade could be
    // *started* and never finished.
    const onChange = renderLanes(animated());
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 0/));
    const field = screen.getByLabelText('Value at frame 0');

    await userEvent.clear(field);
    await userEvent.type(field, '0.3{Enter}');

    expect(onChange).toHaveBeenCalledWith('set keyframe value', expect.anything());
    const first = animatedOpacityFrom(onChange).keyframes[0];
    expect(first?.value).toBe(0.3);
  });

  it('names the change for what it was, so undo says something recognisable', async () => {
    const onChange = renderLanes(animated());
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 0/));
    const field = screen.getByLabelText('Value at frame 0');
    await userEvent.clear(field);
    await userEvent.type(field, '0.9{Enter}');

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('set keyframe value');
  });

  it('adds a keyframe where the lane was double-clicked', () => {
    const onChange = renderLanes(animated());
    const lane = sized(screen.getByLabelText('transform · opacity keyframes'));

    fireEvent.doubleClick(lane, { clientX: 6 });

    expect(onChange).toHaveBeenCalledWith('add keyframe', expect.anything());
    expect(markerFramesFrom(onChange)).toContain(6);
  });

  it('adds it at the value the curve already has there', () => {
    // Adding a marker mid-animation must not change what the animation does — it only makes that
    // instant editable, which is what the gesture means. At the midpoint of a linear 0→1 the value is
    // a half.
    const onChange = renderLanes(animated());
    fireEvent.doubleClick(sized(screen.getByLabelText('transform · opacity keyframes')), { clientX: 6 });

    const opacity = animatedOpacityFrom(onChange);
    const added = opacity.keyframes.find((keyframe) => keyframe.frame === 6);
    expect(added?.value).toBeCloseTo(0.5, 5);
  });

  it('does not disturb the markers already there', () => {
    const onChange = renderLanes(animated());
    fireEvent.doubleClick(sized(screen.getByLabelText('transform · opacity keyframes')), { clientX: 6 });

    expect(markerFramesFrom(onChange)).toEqual([0, 6, 12]);
  });

  it('names each marker by its frame, so a test and a user see the same thing', () => {
    renderLanes(animated());
    expect(screen.getByLabelText(/keyframe at frame 0/)).toBeDefined();
    expect(screen.getByLabelText(/keyframe at frame 12/)).toBeDefined();
  });

  it('shows the easing in the lane rather than hiding it in a menu', () => {
    // Interpolation is per marker, and a curve whose shape is invisible is one the user cannot reason
    // about. The badge sits beside the marker it governs.
    renderLanes(animated());
    expect(screen.getByText('linear')).toBeDefined();
  });

  it('offers the gestures in the lane rather than only in a menu', () => {
    renderLanes(animated());
    expect(screen.getByText(/double-click a lane to add a keyframe/)).toBeDefined();
  });
});

describe('clip-relative positions', () => {
  it('places a marker at the clip´s offset, not at the sequence origin', () => {
    // Keyframe positions are stored clip-relative — that is what lets a clip be moved or split without
    // its animation drifting — and the lane is the only place that converts them to the timeline's
    // frames. A clip starting at 60 therefore shows its frame-0 marker at frame 60.
    const shifted = videoClip({
      span: spanFromBounds(frameIndex(60), frameIndex(180)),
      transform: { ...videoClip().transform, opacity: curve(0, 1) },
    });
    renderLanes(documentWith(shifted));

    expect(screen.getByLabelText(/keyframe at frame 60/)).toBeDefined();
    expect(screen.getByLabelText(/keyframe at frame 72/)).toBeDefined();
  });

  it('shows an unmoved clip´s markers at their own frames', () => {
    renderLanes(documentWith(videoClip({ transform: { ...videoClip().transform, opacity: curve(0, 1) } })));
    expect(screen.getByLabelText(/keyframe at frame 0/)).toBeDefined();
    expect(screen.getByLabelText(/keyframe at frame 12/)).toBeDefined();
  });
});
