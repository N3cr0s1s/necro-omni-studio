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
import { type KeyframeLanesProps, type KeyframeLanesResult, useKeyframeLanes } from './KeyframeLanes.js';
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

/**
 * The hook, mounted.
 *
 * `useKeyframeLanes` returns rows rather than markup, because the timeline has to draw a header
 * beside each one — so the tests place the bodies themselves, exactly as the timeline does. Rendering
 * them any other way would be testing a layout nothing ships.
 */
function Harness(props: KeyframeLanesProps & { readonly report?: (result: KeyframeLanesResult) => void }) {
  const result = useKeyframeLanes(props);
  props.report?.(result);
  return (
    <div>
      {result.rows.map((row) => (
        <div key={row.id} data-lane-row={row.id} style={{ height: row.heightPx }}>
          {row.body}
        </div>
      ))}
    </div>
  );
}

const renderLanes = (document: TimelineDocument, clip = 'c1') => {
  const onChange = vi.fn();
  render(
    <Harness
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

/** The hook's own result, for the parts of it the lanes do not render. */
const mountLanes = (document: TimelineDocument, clip = 'c1') => {
  const onChange = vi.fn();
  let latest: KeyframeLanesResult | undefined;
  render(
    <Harness
      document={document}
      clip={clip}
      effects={effects}
      viewport={viewport}
      playhead={frameIndex(0)}
      onChange={onChange}
      report={(result) => {
        latest = result;
      }}
    />,
  );
  return { onChange, result: () => latest! };
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
      <Harness
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

/**
 * The selection, carried out to the right column.
 *
 * Issue #37: clicking a marker selected it and the panel went on describing the clip, so every
 * property of a keyframe except its value and its easing was unreachable. The hook is the one owner
 * of "which marker is selected" — two owners is how a marker comes to be highlighted in one place and
 * edited in another.
 */
describe('the selected marker', () => {
  const animated = (start = 0) =>
    documentWith(
      videoClip({
        span: spanFromBounds(frameIndex(start), frameIndex(start + 120)),
        transform: { ...videoClip().transform, opacity: curve(0, 1) },
      }),
    );

  it('is nothing until a marker is clicked', () => {
    const { result } = mountLanes(animated());
    expect(result().selected).toBeUndefined();
  });

  it('names the parameter and reports the marker itself', async () => {
    const { result } = mountLanes(animated());
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 0/));

    expect(result().selected?.label).toBe('transform · opacity');
    expect(result().selected?.keyframe.value).toBe(0);
    expect(result().selected?.last).toBe(false);
  });

  it('reports the frame on the timeline, not the offset into the clip', async () => {
    // Keyframes are stored clip-relative so a clip can be moved without its animation drifting; every
    // number the user reads is a timeline position. A marker 12 frames into a clip at 300 is 312.
    const { result } = mountLanes(animated(300));
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 312/));
    expect(result().selected?.keyframe.frame).toBe(12);
    expect(result().selected?.absoluteFrame).toBe(312);
  });

  it('marks the last marker, whose easing governs nothing', async () => {
    const { result } = mountLanes(animated());
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 12/));
    expect(result().selected?.last).toBe(true);
  });

  it('rebases a frame typed as a timeline position back into the clip', async () => {
    const { onChange, result } = mountLanes(animated(300));
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 300/));
    expect(result().selected?.absoluteFrame).toBe(300);

    result().edit({ frame: frameIndex(340) });

    // Looked up by id, not by position: markers are kept in frame order, and moving one past its
    // neighbour changes which index it occupies.
    const next = onChange.mock.calls.at(-1)![1] as TimelineDocument;
    const clip = locateClip(next, clipId('c1'))!.clip as VideoClip;
    const opacity = clip.transform.opacity;
    const moved = isAnimated(opacity)
      ? opacity.keyframes.find((entry) => entry.id === keyframeId('k0'))
      : undefined;
    expect(moved?.frame).toBe(40);
  });

  it('changes easing directly, without cycling to it', async () => {
    const { onChange, result } = mountLanes(animated());
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 0/));
    result().edit({ ease: 'hold' });

    const next = onChange.mock.calls.at(-1)![1] as TimelineDocument;
    const clip = locateClip(next, clipId('c1'))!.clip as VideoClip;
    const opacity = clip.transform.opacity;
    expect(isAnimated(opacity) ? opacity.keyframes[0]!.ease : undefined).toBe('hold');
  });

  it('removes the marker and forgets it, so nothing stays selected that is gone', async () => {
    const { onChange, result } = mountLanes(animated());
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 0/));
    result().remove();

    const next = onChange.mock.calls.at(-1)![1] as TimelineDocument;
    const clip = locateClip(next, clipId('c1'))!.clip as VideoClip;
    const opacity = clip.transform.opacity;
    expect(isAnimated(opacity) ? opacity.keyframes.length : -1).toBe(1);
  });

  it('does nothing when asked to edit with nothing selected', () => {
    const { onChange, result } = mountLanes(animated());
    result().edit({ value: 0.5 });
    result().remove();
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * The lanes as rows.
 *
 * The report was two symptoms of one cause: a lane appeared with nothing beside it in the header
 * column, so it said nothing about which parameter it animated *and* the two columns came apart. Rows
 * carry their own height and label so the timeline can draw both halves from one number.
 */
describe('the rows the hook produces', () => {
  it('gives each lane a label and a height', () => {
    const { result } = mountLanes(
      documentWith(videoClip({ transform: { ...videoClip().transform, opacity: curve(0, 1) } })),
    );
    const lane = result().rows[0]!;
    expect(lane.label).toBe('transform · opacity');
    expect(lane.heightPx).toBeGreaterThan(0);
  });

  it('makes the hint a row of its own, so it too has a header beside it', () => {
    // Anything under a track that is not a row has no header opposite it, and pushes every row below
    // out of step — which is the whole of what was wrong.
    const { result } = mountLanes(
      documentWith(videoClip({ transform: { ...videoClip().transform, opacity: curve(0, 1) } })),
    );
    expect(result().rows.at(-1)?.id).toBe('lane-hint');
    expect(result().rows.every((row) => row.heightPx > 0)).toBe(true);
  });

  it('produces no rows at all when nothing is animated', () => {
    const { result } = mountLanes(documentWith(videoClip()));
    expect(result().rows).toEqual([]);
  });
});

/**
 * What a shared helper keeps you from forgetting.
 *
 * The lanes wrote clips back through a hand-rolled copy of `updateClip` that was missing two things,
 * and both are invisible until someone looks for them: it rebuilt every track, and it did not check
 * the lock. Found by counting how many times a function name is defined — the sweep this codebase's
 * real bugs keep coming from.
 */
describe('writing a clip back', () => {
  const animated = () =>
    documentWith(videoClip({ transform: { ...videoClip().transform, opacity: curve(0, 1) } }));

  it('keeps untouched tracks by reference, which is what makes undo cost pointers', async () => {
    const before = animated();
    const { onChange, result } = mountLanes(before);
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 0/));
    result().edit({ value: 0.25 });

    const after = onChange.mock.calls.at(-1)![1] as TimelineDocument;
    const untouched = after.sequence.tracks.filter((track, index) => track === before.sequence.tracks[index]);
    // Every track but the one holding the clip must be the *same object*.
    expect(untouched.length).toBe(before.sequence.tracks.length - 1);
  });

  /*
   * The same lock, on an *effect* parameter lane.
   *
   * The transform lanes went through the shared helper and the effect lanes did not — a second copy
   * three hundred lines below the first, in the same file, missed when the first was fixed. So on a
   * locked track the opacity markers refused and the Film Grain markers beside them, drawn by the same
   * component and looking identical, did not.
   *
   * Fixing two copies of three is what silences the sweep that finds them, which is the argument for
   * a test per lane kind rather than one for "the lanes".
   */
  it('refuses on a locked track for an effect parameter too', async () => {
    const withEffect = documentWith(
      videoClip({
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: { amount: curve(0, 1) },
          },
        ],
      }),
    );
    const locked = {
      ...withEffect,
      sequence: {
        ...withEffect.sequence,
        tracks: withEffect.sequence.tracks.map((track) =>
          track.kind === 'video' ? { ...track, locked: true } : track,
        ) as TimelineDocument['sequence']['tracks'],
      },
    };

    const { onChange, result } = mountLanes(locked);
    await userEvent.click(screen.getByLabelText(/amount keyframe at frame 0/));
    result().edit({ value: 0.25 });

    const paramOf = (doc: TimelineDocument) =>
      (locateClip(doc, clipId('c1'))!.clip as VideoClip).effects[0]?.params['amount'];
    const after = onChange.mock.calls.at(-1)?.[1] as TimelineDocument | undefined;

    // Unchanged, whether the panel committed the same document back or committed nothing at all.
    expect(after === undefined ? paramOf(locked) : paramOf(after)).toEqual(paramOf(locked));
  });

  it('refuses on a locked track, which the timeline already enforced everywhere else', async () => {
    const locked = {
      ...animated(),
      sequence: {
        ...animated().sequence,
        tracks: animated().sequence.tracks.map((track) =>
          track.kind === 'video' ? { ...track, locked: true } : track,
        ) as TimelineDocument['sequence']['tracks'],
      },
    };
    const { onChange, result } = mountLanes(locked);
    await userEvent.click(screen.getByLabelText(/opacity keyframe at frame 0/));
    result().edit({ value: 0.25 });

    // The document is handed back unchanged rather than the edit landing: a lock that stops a drag
    // and not a number field is a lock nobody can rely on.
    const after = onChange.mock.calls.at(-1)?.[1] as TimelineDocument | undefined;
    const opacity =
      after === undefined
        ? undefined
        : (locateClip(after, clipId('c1'))!.clip as VideoClip).transform.opacity;
    expect(opacity === undefined || (isAnimated(opacity) && opacity.keyframes[0]!.value === 0)).toBe(true);
  });
});
