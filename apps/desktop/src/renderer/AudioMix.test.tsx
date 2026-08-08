// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AudioClip,
  type AudioTrack,
  type Clip,
  type TimelineDocument,
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
import { gainToDb } from '@nos/audio';
import { AudioMix, clampGainDb, describePan, snapPan } from './AudioMix.js';

/**
 * Level and pan for an audio clip.
 *
 * The mix graph and the export have always read these; nothing could write them. What is asserted
 * here is the boundary this component owns — decibels in the interface, linear in the document — and
 * the rules that make the control usable: unity is reachable exactly, centre has a detent, and an
 * animated value is not editable in two places at once.
 */

afterEach(cleanup);

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: 'audio',
    id: clipId('a1'),
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
    ...overrides,
  } as AudioClip;
}

function documentWith(clip: Clip): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'test',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1t'), text: trackId('t1') },
  });

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === 'audio' ? ({ ...track, clips: [clip] } as AudioTrack) : track,
      ),
    },
  };
}

function mount(clip: Clip = audioClip(), playhead = 0) {
  const onChange = vi.fn();
  const document = documentWith(clip);
  render(<AudioMix document={document} clip={clip} playhead={playhead} onChange={onChange} />);
  return { onChange, document };
}

/** The clip as the last commit left it. */
function committed(onChange: ReturnType<typeof vi.fn>): AudioClip {
  const next = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
  const located = locateClip(next, clipId('a1'));
  if (located === undefined || located.clip.kind !== 'audio') throw new Error('no audio clip');
  return located.clip;
}

describe('what it applies to', () => {
  it('says nothing about a video clip', () => {
    const video = { ...audioClip(), kind: 'video' } as unknown as Clip;
    render(<AudioMix document={documentWith(video)} clip={video} playhead={0} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Gain in decibels')).toBeNull();
  });
});

describe('decibels at the boundary', () => {
  it('shows unity as 0 dB', () => {
    mount();
    expect(screen.getByText('0.0 dB')).toBeDefined();
  });

  it('writes a linear gain, because that is what the mix graph reads', () => {
    const { onChange } = mount();
    fireEvent.change(screen.getByLabelText('Gain in decibels'), { target: { value: '-6' } });

    const gain = committed(onChange).gain;
    expect(isAnimated(gain)).toBe(false);
    expect(evaluateAt(gain, frameIndex(0))).toBeCloseTo(0.501, 2);
  });

  it('reaches exact silence at the bottom of the range', () => {
    // The control has to be able to mute a clip, not merely approach it — the range bottoms out at
    // the mix graph's own floor, where gain is defined to be zero.
    const { onChange } = mount();
    fireEvent.change(screen.getByLabelText('Gain in decibels'), { target: { value: '-60' } });

    expect(evaluateAt(committed(onChange).gain, frameIndex(0))).toBe(0);
  });

  it('returns to unity exactly, which dragging a fader cannot', () => {
    const { onChange } = mount(audioClip({ gain: staticNumber(0.3) }));
    screen.getByText('0 dB').click();

    expect(evaluateAt(committed(onChange).gain, frameIndex(0))).toBe(1);
  });

  it('shows a silent clip as −∞ rather than a large negative number', () => {
    mount(audioClip({ gain: staticNumber(0) }));
    expect(screen.getByText('−∞ dB')).toBeDefined();
  });

  it('keeps the slider inside its range for a gain far above it', () => {
    // A document can hold any number — a preset, a hand-edited file. The control must show something
    // rather than render an out-of-range slider that appears to be at zero.
    mount(audioClip({ gain: staticNumber(1000) }));
    const slider = screen.getByLabelText('Gain in decibels') as HTMLInputElement;
    expect(Number(slider.value)).toBe(12);
  });
});

describe('pan', () => {
  it('reads out the side, not the number', () => {
    mount(audioClip({ pan: staticNumber(-0.35) }));
    expect(screen.getByText('L35')).toBeDefined();
  });

  it('snaps to centre near the middle, where a fader is hard to place', () => {
    const { onChange } = mount();
    fireEvent.change(screen.getByLabelText('Pan'), { target: { value: '0.01' } });

    expect(evaluateAt(committed(onChange).pan, frameIndex(0))).toBe(0);
  });

  it('does not snap a deliberate small offset away', () => {
    const { onChange } = mount();
    fireEvent.change(screen.getByLabelText('Pan'), { target: { value: '0.2' } });

    expect(evaluateAt(committed(onChange).pan, frameIndex(0))).toBeCloseTo(0.2, 3);
  });

  it('centres exactly on request', () => {
    const { onChange } = mount(audioClip({ pan: staticNumber(0.8) }));
    screen.getByText('centre').click();

    expect(evaluateAt(committed(onChange).pan, frameIndex(0))).toBe(0);
  });
});

describe('animation', () => {
  it('is an explicit act, not something a first edit causes', () => {
    const { onChange } = mount();
    fireEvent.change(screen.getByLabelText('Gain in decibels'), { target: { value: '-3' } });

    expect(isAnimated(committed(onChange).gain)).toBe(false);
  });

  it('starts from the value that is there', () => {
    const { onChange } = mount(audioClip({ gain: staticNumber(0.5) }));
    screen.getAllByText('animate')[0]?.click();

    const gain = committed(onChange).gain;
    expect(isAnimated(gain)).toBe(true);
    expect(evaluateAt(gain, frameIndex(0))).toBeCloseTo(0.5, 5);
  });

  it('locks the slider, so a value cannot be edited in two places at once', () => {
    mount(
      audioClip({
        gain: animatedNumber([
          { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
          { id: keyframeId('k1'), frame: frameIndex(100), value: 0, ease: 'linear' },
        ]),
      }),
    );

    expect((screen.getByLabelText('Gain in decibels') as HTMLInputElement).disabled).toBe(true);
  });

  it('reads out what is heard at the playhead, not the first keyframe', () => {
    // Beside a transport, the only number worth showing is the one currently in effect.
    mount(
      audioClip({
        gain: animatedNumber([
          { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
          { id: keyframeId('k1'), frame: frameIndex(100), value: 0, ease: 'linear' },
        ]),
      }),
      100,
    );

    expect(screen.getByText('−∞ dB')).toBeDefined();
  });

  it('keeps the value at the playhead when un-animating', () => {
    // The number the user is looking at when they press the button is the one they mean to keep.
    const { onChange } = mount(
      audioClip({
        gain: animatedNumber([
          { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
          { id: keyframeId('k1'), frame: frameIndex(100), value: 0.25, ease: 'linear' },
        ]),
      }),
      100,
    );
    screen.getByText('un-animate').click();

    const gain = committed(onChange).gain;
    expect(isAnimated(gain)).toBe(false);
    expect(evaluateAt(gain, frameIndex(0))).toBeCloseTo(0.25, 5);
  });

  it('samples clip-relative, so a clip moved down the timeline keeps its shape', () => {
    const clip = audioClip({
      span: spanFromBounds(frameIndex(500), frameIndex(800)),
      gain: animatedNumber([
        { id: keyframeId('k0'), frame: frameIndex(0), value: 1, ease: 'linear' },
        { id: keyframeId('k1'), frame: frameIndex(100), value: 0, ease: 'linear' },
      ]),
    });
    mount(clip, 500);

    expect(screen.getByText('0.0 dB')).toBeDefined();
  });
});

describe('history', () => {
  it('labels each change as what it was, so undo names something recognisable', () => {
    const { onChange } = mount();
    fireEvent.change(screen.getByLabelText('Pan'), { target: { value: '0.5' } });

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('set pan');
  });
});

describe('the pure rules', () => {
  it('describes centre as centre', () => {
    expect(describePan(0)).toBe('C');
    expect(describePan(0.01)).toBe('C');
  });

  it('names both sides', () => {
    expect(describePan(1)).toBe('R100');
    expect(describePan(-1)).toBe('L100');
  });

  it('clamps a pan beyond the field rather than reporting L140', () => {
    expect(snapPan(-4)).toBe(-1);
    expect(snapPan(4)).toBe(1);
  });

  it('clamps gain to the range the control can show', () => {
    expect(clampGainDb(gainToDb(0))).toBe(-60);
    expect(clampGainDb(200)).toBe(12);
  });
});
