// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type VideoTrack,
  FRAME_RATES,
  animatedNumber,
  assetPath,
  clipId,
  createDocument,
  evaluateAt,
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
import { clipTransform, neutralTransform } from '@nos/editing';
import { TransformInspector } from './TransformInspector.js';

/**
 * Framing controls.
 *
 * The compositor read all five channels per frame and nothing could write one, so every clip sat
 * centred, unscaled and fully opaque. What is asserted here is that each control reaches the document
 * and that the panel tells the truth about an animated channel — a slider that silently disagreed with
 * a keyframe lane would be worse than the missing control it replaced.
 */

afterEach(cleanup);

function videoClip(overrides: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId('c1'),
    span: spanFromBounds(frameIndex(100), frameIndex(400)),
    label: 'take.mp4',
    enabled: true,
    effects: [],
    source: {
      asset: assetPath('media/take.mp4'),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform: neutralTransform(),
    speed: { factor: 1, preservePitch: true },
    ...overrides,
  } as Clip;
}

function documentWith(clip: Clip): TimelineDocument {
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
        track.kind === 'video' ? ({ ...track, clips: [clip] } as VideoTrack) : track,
      ),
    },
  };
}

function mount(clip: Clip = videoClip(), playhead = 100) {
  const onChange = vi.fn();
  const onReject = vi.fn();
  render(
    <TransformInspector
      document={documentWith(clip)}
      clip={clip}
      playhead={playhead}
      onChange={onChange}
      onReject={onReject}
    />,
  );
  return { onChange, onReject };
}

/** The framing as the last commit left it. */
function committed(onChange: ReturnType<typeof vi.fn>) {
  const next = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
  const located = locateClip(next, clipId('c1'));
  if (located === undefined) throw new Error('no clip');
  return clipTransform(located.clip)!;
}

describe('what it applies to', () => {
  it('says nothing about an audio clip, which has nothing to place', () => {
    const audio = { ...videoClip(), kind: 'audio' } as unknown as Clip;
    render(
      <TransformInspector
        document={documentWith(audio)}
        clip={audio}
        playhead={0}
        onChange={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('opacity value')).toBeNull();
  });

  it('offers every channel the compositor reads', () => {
    mount();
    for (const channel of ['x', 'y', 'scale', 'rotation', 'opacity']) {
      expect(screen.getByLabelText(`${channel} value`)).toBeDefined();
    }
  });
});

describe('writing a channel', () => {
  it('reaches the document', async () => {
    const { onChange } = mount();
    const field = screen.getByLabelText('scale value');

    await userEvent.clear(field);
    await userEvent.type(field, '2{Enter}');

    expect(evaluateAt(committed(onChange).scale, frameIndex(0))).toBe(2);
  });

  it('takes a value the slider does not span, because the slider is a convenience', async () => {
    // Scaling to 8× is legitimate; the slider simply stops at 4.
    const { onChange } = mount();
    const field = screen.getByLabelText('scale value');
    await userEvent.clear(field);
    await userEvent.type(field, '8{Enter}');

    expect(evaluateAt(committed(onChange).scale, frameIndex(0))).toBe(8);
  });

  it('names the change for what it was, so undo says something recognisable', async () => {
    const { onChange } = mount();
    const field = screen.getByLabelText('rotation value');
    await userEvent.clear(field);
    await userEvent.type(field, '9{Enter}');

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('set rotation');
  });

  it('ignores a field cleared to be typed into, rather than writing zero', async () => {
    // `Number('')` is `0`, so a control that wrote on every keystroke would set opacity to zero the
    // moment the contents were selected to be replaced — a black frame from an unfinished keystroke.
    const { onChange } = mount();
    await userEvent.clear(screen.getByLabelText('opacity value'));
    await userEvent.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not fight a value being typed in pieces', async () => {
    // `-` and `0.` are not numbers. A field that refused them would be unusable for `-0.5`.
    const { onChange } = mount();
    const field = screen.getByLabelText('x value');
    await userEvent.clear(field);
    await userEvent.type(field, '-0.5{Enter}');

    expect(evaluateAt(committed(onChange).x, frameIndex(0))).toBe(-0.5);
  });
});

describe('animating a channel', () => {
  it('is an explicit act, not something a first edit causes', async () => {
    const { onChange } = mount();
    const field = screen.getByLabelText('opacity value');
    await userEvent.clear(field);
    await userEvent.type(field, '0{Enter}');

    expect(isAnimated(committed(onChange).opacity)).toBe(false);
  });

  it('starts from the value that is there', async () => {
    const framed = videoClip({
      transform: { ...neutralTransform(), scale: staticNumber(1.5) },
    } as Partial<Clip>);
    const { onChange } = mount(framed);

    await userEvent.click(screen.getByLabelText('Animate scale'));

    const scale = committed(onChange).scale;
    expect(isAnimated(scale)).toBe(true);
    expect(evaluateAt(scale, frameIndex(0))).toBe(1.5);
  });

  it('locks the value controls, so one value cannot be edited in two places', () => {
    const fading = videoClip({
      transform: {
        ...neutralTransform(),
        opacity: animatedNumber([
          { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
          { id: keyframeId('k1'), frame: frameIndex(100), value: 0, ease: 'linear' },
        ]),
      },
    } as Partial<Clip>);
    mount(fading);

    expect((screen.getByLabelText('opacity value') as HTMLInputElement).disabled).toBe(true);
  });

  it('reads out what is on screen at the playhead, not the first keyframe', () => {
    // Clip-relative: the clip starts at 100, so a playhead at 200 is frame 100 of its animation.
    const fading = videoClip({
      transform: {
        ...neutralTransform(),
        opacity: animatedNumber([
          { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
          { id: keyframeId('k1'), frame: frameIndex(100), value: 0, ease: 'linear' },
        ]),
      },
    } as Partial<Clip>);
    mount(fading, 200);

    expect(screen.getByLabelText('opacity value')).toHaveProperty('value', '0');
  });

  it('keeps the value at the playhead when un-animating', async () => {
    const fading = videoClip({
      transform: {
        ...neutralTransform(),
        opacity: animatedNumber([
          { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
          { id: keyframeId('k1'), frame: frameIndex(100), value: 0.25, ease: 'linear' },
        ]),
      },
    } as Partial<Clip>);
    const { onChange } = mount(fading, 200);

    await userEvent.click(screen.getByLabelText('Stop animating opacity'));

    const opacity = committed(onChange).opacity;
    expect(isAnimated(opacity)).toBe(false);
    expect(evaluateAt(opacity, frameIndex(0))).toBeCloseTo(0.25, 5);
  });
});

describe('resetting', () => {
  it('is offered only once there is something to reset', () => {
    mount();
    expect(screen.getByRole('button', { name: /Reset/ }).hasAttribute('disabled')).toBe(true);
  });

  it('returns every channel to neutral exactly', async () => {
    const framed = videoClip({
      transform: {
        ...neutralTransform(),
        x: staticNumber(0.4),
        scale: staticNumber(1.75),
      },
    } as Partial<Clip>);
    const { onChange } = mount(framed);

    await userEvent.click(screen.getByRole('button', { name: /Reset/ }));

    expect(committed(onChange)).toEqual(neutralTransform());
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('reset framing');
  });
});
