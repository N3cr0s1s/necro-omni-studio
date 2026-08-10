// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
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

/**
 * The range input inside a slider's thumb.
 *
 * Base UI puts the accessible name on the group and a real `<input type="range">` inside the thumb, so
 * that is what a change is dispatched at — the group itself has no value to set.
 */
function slider(label: string): HTMLInputElement {
  // The label names the range input directly now. It used to sit on the slider's *root*, where it
  // named a `div` and left the input anonymous — so this had to reach inside to find the control.
  const named = screen.getByLabelText(label);
  const found = named instanceof HTMLInputElement ? named : named.querySelector('input[type="range"]');
  if (found === null) throw new Error(`no range input inside ${label}`);
  return found as HTMLInputElement;
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
    fireEvent.change(slider('Gain in decibels'), { target: { value: '-6' } });

    const gain = committed(onChange).gain;
    expect(isAnimated(gain)).toBe(false);
    expect(evaluateAt(gain, frameIndex(0))).toBeCloseTo(0.501, 2);
  });

  it('reaches exact silence at the bottom of the range', () => {
    // The control has to be able to mute a clip, not merely approach it — the range bottoms out at
    // the mix graph's own floor, where gain is defined to be zero.
    const { onChange } = mount();
    fireEvent.change(slider('Gain in decibels'), { target: { value: '-60' } });

    expect(evaluateAt(committed(onChange).gain, frameIndex(0))).toBe(0);
  });

  it('returns to unity exactly, which dragging a fader cannot', () => {
    const { onChange } = mount(audioClip({ gain: staticNumber(0.3) }));
    // Scoped: the track below has its own unity button, and the two must not be confused.
    within(screen.getByRole('region', { name: 'Clip audio' }))
      .getByRole('button', { name: /0 dB/ })
      .click();

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
    expect(Number(slider('Gain in decibels').value)).toBe(12);
  });
});

describe('pan', () => {
  it('reads out the side, not the number', () => {
    mount(audioClip({ pan: staticNumber(-0.35) }));
    expect(screen.getByText('L35')).toBeDefined();
  });

  it('snaps to centre near the middle, where a fader is hard to place', () => {
    const { onChange } = mount();
    fireEvent.change(slider('Pan'), { target: { value: '0.01' } });

    expect(evaluateAt(committed(onChange).pan, frameIndex(0))).toBe(0);
  });

  it('does not snap a deliberate small offset away', () => {
    const { onChange } = mount();
    fireEvent.change(slider('Pan'), { target: { value: '0.2' } });

    expect(evaluateAt(committed(onChange).pan, frameIndex(0))).toBeCloseTo(0.2, 3);
  });

  it('centres exactly on request', () => {
    const { onChange } = mount(audioClip({ pan: staticNumber(0.8) }));
    within(screen.getByRole('region', { name: 'Clip audio' }))
      .getByRole('button', { name: /centre/ })
      .click();

    expect(evaluateAt(committed(onChange).pan, frameIndex(0))).toBe(0);
  });
});

describe('animation', () => {
  it('is an explicit act, not something a first edit causes', () => {
    const { onChange } = mount();
    fireEvent.change(slider('Gain in decibels'), { target: { value: '-3' } });

    expect(isAnimated(committed(onChange).gain)).toBe(false);
  });

  it('starts from the value that is there', () => {
    const { onChange } = mount(audioClip({ gain: staticNumber(0.5) }));
    screen.getByLabelText('Animate gain').click();

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

    expect(slider('Gain in decibels').disabled).toBe(true);
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
    screen.getByLabelText('Stop animating gain').click();

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
    fireEvent.change(slider('Pan'), { target: { value: '0.5' } });

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

/**
 * The track's own contribution.
 *
 * `track.gain` has been multiplied into every clip on the track since the mix plan was written and
 * `track.pan` combined with each clip's — and nothing could set either, so both sat at unity and
 * centre for the life of every project. Balancing a mix meant editing every clip one at a time.
 */
describe('the track under the clip', () => {
  const trackRegion = () => within(screen.getByRole('region', { name: 'Track audio' }));

  /** The audio track as the last commit left it. */
  function committedTrack(onChange: ReturnType<typeof vi.fn>) {
    const next = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
    const track = next.sequence.tracks.find((entry) => entry.kind === 'audio');
    if (track?.kind !== 'audio') throw new Error('no audio track');
    return track;
  }

  it('is shown beside the clip, because a level is read against something', () => {
    mount(audioClip());
    expect(screen.getByRole('region', { name: 'Track audio' })).toBeTruthy();
  });

  it('sets the track level without touching the clip', () => {
    const { onChange } = mount(audioClip({ gain: staticNumber(0.5) }));
    trackRegion().getByRole('button', { name: /0 dB/ }).click();

    const track = committedTrack(onChange);
    expect(track.gain).toBe(1);
    // The clip's own gain is untouched: two faders in series, not one.
    const clip = committedTrack(onChange).clips[0];
    expect(clip?.gain).toEqual(staticNumber(0.5));
  });

  it('centres the track pan', () => {
    const { onChange } = mount(audioClip());
    trackRegion()
      .getByRole('button', { name: /centre/ })
      .click();
    expect(committedTrack(onChange).pan).toBe(0);
  });

  it('names its faders after the track, so two levels are told apart', () => {
    mount(audioClip());
    // The clip's is bare; the track's carries the track name, so the two are never confused.
    expect(screen.getByLabelText('Gain in decibels')).toBeTruthy();
    expect(screen.getByLabelText('A1 gain in decibels')).toBeTruthy();
    expect(screen.getByLabelText('A1 pan')).toBeTruthy();
  });

  it('offers no animation, because a track is the constant clips are heard through', () => {
    // `track.gain` is a number where `clip.gain` is an `AnimatableNumber`; the document models the
    // difference and the panel must not offer what it cannot store.
    mount(audioClip());
    expect(trackRegion().queryByRole('button', { name: /animate/i })).toBeNull();
  });
});

/*
 * A locked track, from the mix.
 *
 * `replaceAudioChannel` rebuilt the tracks itself and asked nobody, so a locked audio track's clips
 * could still be re-levelled and re-panned from this panel — which is exactly the change a lock is put
 * on to prevent. It goes through `updateClip` now, and the fader returns to where the document says it
 * is, because it is drawn from the document.
 */
describe('a locked track', () => {
  const locked = (): TimelineDocument => {
    const base = documentWith(audioClip());
    return {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.kind === 'audio' ? ({ ...track, locked: true } as AudioTrack) : track,
        ),
      },
    };
  };

  it('refuses a change to the clip gain', () => {
    const onChange = vi.fn();
    const clip = audioClip();
    render(<AudioMix document={locked()} clip={clip} playhead={0} onChange={onChange} />);

    fireEvent.change(slider('Gain in decibels'), { target: { value: '-6' } });

    // Committed with the document unchanged rather than not committed at all: the panel does not know
    // the lock, and the operation refusing is what makes the value snap back.
    const next = onChange.mock.calls.at(-1)?.[1] as TimelineDocument | undefined;
    if (next !== undefined) {
      const located = locateClip(next, clipId('a1'));
      expect(located?.clip.kind === 'audio' ? located.clip.gain : undefined).toEqual(clip.gain);
    }
  });
});
