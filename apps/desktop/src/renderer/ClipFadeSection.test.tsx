// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type TimelineDocument,
  type VideoClip,
  FRAME_RATES,
  assetPath,
  clipFade,
  clipId,
  createDocument,
  frameIndex,
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { ClipFadeSection } from './ClipFadeSection.js';

/**
 * Typing a ramp's length.
 *
 * The handles on the clip are the gesture; this is the frame-accurate way to say the same thing, per
 * the rule that a value which can be dragged must also be typeable. What the assertions guard is that
 * the two fields stay independent — an edit to one that quietly rewrote the other would be worse than
 * having neither.
 */

afterEach(cleanup);

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

function videoClip(fade?: NonNullable<VideoClip['fade']>): VideoClip {
  return {
    kind: 'video',
    id: clipId('c1'),
    span: spanFromBounds(frameIndex(100), frameIndex(190)),
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
    ...(fade === undefined ? {} : { fade }),
  };
}

function audioClip(): AudioClip {
  return {
    kind: 'audio',
    id: clipId('c1'),
    span: spanFromBounds(frameIndex(0), frameIndex(60)),
    label: 'c1',
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/x.wav'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
  };
}

function documentWith(clip: Clip): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === clip.kind || (track.kind === 'video' && clip.kind === 'image')
          ? ({ ...track, clips: [clip] } as typeof track)
          : track,
      ),
    },
  };
}

function mount(clip: Clip = videoClip()) {
  const document = documentWith(clip);
  const onChange = vi.fn();
  const onReject = vi.fn();
  render(
    <ClipFadeSection
      document={document}
      clip={locateClip(document, clipId('c1'))!.clip}
      onChange={onChange}
      onReject={onReject}
    />,
  );
  return { onChange, onReject };
}

const committedFade = (onChange: ReturnType<typeof vi.fn>) => {
  const next = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
  return clipFade(locateClip(next, clipId('c1'))!.clip);
};

async function type(field: string, value: string): Promise<void> {
  const user = userEvent.setup();
  const input = screen.getByLabelText(field);
  await user.clear(input);
  await user.type(input, `${value}{Enter}`);
}

describe('what it shows', () => {
  it('states both ramps, at zero when the clip has none', () => {
    mount();
    expect((screen.getByLabelText('fade in') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('fade out') as HTMLInputElement).value).toBe('0');
  });

  it('reads the ramps a crossfade wrote', () => {
    mount(videoClip({ inFrames: 20, outFrames: 5 }));
    expect((screen.getByLabelText('fade in') as HTMLInputElement).value).toBe('20');
    expect((screen.getByLabelText('fade out') as HTMLInputElement).value).toBe('5');
  });

  it('offers the ramps on a sound as readily as on a picture', () => {
    // A ramp means something in both domains, so both get the same two fields.
    mount(audioClip());
    expect(screen.getByLabelText('fade in')).toBeDefined();
    expect(screen.getByLabelText('fade out')).toBeDefined();
  });

  it('offers a clear only when there is something to clear', () => {
    mount();
    expect(screen.queryByTitle('Remove both ramps')).toBeNull();
    cleanup();
    mount(videoClip({ inFrames: 10, outFrames: 0 }));
    expect(screen.getByTitle('Remove both ramps')).toBeDefined();
  });
});

describe('what it changes', () => {
  it('sets one ramp and leaves the other alone', async () => {
    const { onChange } = mount(videoClip({ inFrames: 4, outFrames: 9 }));
    await type('fade in', '24');
    expect(committedFade(onChange)).toEqual({ inFrames: 24, outFrames: 9 });
  });

  it('clamps to the clip rather than refusing', async () => {
    // The clip is 90 frames long. A ramp longer than that renders identically to one exactly as long,
    // so stopping the edit at a limit nothing on screen marks would be the worse answer.
    const { onChange, onReject } = mount();
    await type('fade out', '500');
    expect(committedFade(onChange).outFrames).toBe(90);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('removes both ramps on clear', async () => {
    const user = userEvent.setup();
    const { onChange } = mount(videoClip({ inFrames: 10, outFrames: 12 }));
    await user.click(screen.getByTitle('Remove both ramps'));
    expect(committedFade(onChange)).toEqual({ inFrames: 0, outFrames: 0 });
  });

  it('commits nothing when the value is unchanged, so no history entry is recorded', async () => {
    const { onChange } = mount(videoClip({ inFrames: 10, outFrames: 0 }));
    await type('fade in', '10');
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * The curve a ramp follows.
 *
 * Offered only once there is a ramp, because a curve for a fade that does not exist describes
 * nothing — and a control that cannot change what you see teaches you to ignore the panel.
 */
describe('the curve', () => {
  it('is not offered until there is a ramp to shape', () => {
    mount();
    expect(screen.queryByRole('radiogroup', { name: 'fade curve' })).toBeNull();
  });

  it('offers the renderer default alongside the easings', () => {
    // `default` is not an easing: it is each renderer's own answer, and they differ. Naming it
    // `linear` would be a lie on the audio side.
    mount(videoClip({ inFrames: 10, outFrames: 0 }));
    expect(screen.getByRole('radio', { name: 'default' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'linear' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'curve' })).toBeDefined();
  });

  it('marks the chosen curve', () => {
    mount(videoClip({ inFrames: 10, outFrames: 0, shape: 'ease-in' }));
    expect(screen.getByRole('radio', { name: 'ease-in' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'default' }).getAttribute('aria-checked')).toBe('false');
  });

  it('writes a chosen curve', async () => {
    const { onChange } = mount(videoClip({ inFrames: 10, outFrames: 0 }));
    await userEvent.click(screen.getByRole('radio', { name: 'ease-out' }));
    expect(committedFade(onChange).shape).toBe('ease-out');
  });

  it('goes back to the default, which is absence', async () => {
    const { onChange } = mount(videoClip({ inFrames: 10, outFrames: 0, shape: 'ease-in' }));
    await userEvent.click(screen.getByRole('radio', { name: 'default' }));
    expect(committedFade(onChange).shape).toBeUndefined();
  });

  it('gives a hand-drawn curve something to draw', async () => {
    const { onChange } = mount(videoClip({ inFrames: 10, outFrames: 0 }));
    await userEvent.click(screen.getByRole('radio', { name: 'curve' }));
    // Chosen *with* its points, so a marker can never be in that mode with nothing to draw.
    expect(committedFade(onChange).shape).toBe('bezier');
    expect(committedFade(onChange).shapeBezier).toBeDefined();
  });

  it('shows the editor only while the curve is the one in use', () => {
    mount(videoClip({ inFrames: 10, outFrames: 0, shape: 'ease-in' }));
    expect(screen.queryByRole('group', { name: 'easing curve' })).toBeNull();
    cleanup();
    mount(videoClip({ inFrames: 10, outFrames: 0, shape: 'bezier' }));
    expect(screen.getByRole('group', { name: 'easing curve' })).toBeDefined();
  });
});
