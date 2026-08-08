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
import { ClipTiming } from './ClipTiming.js';

/**
 * Typing a clip's timing.
 *
 * §6.1 asks for frame-accurate cutting and trimming, and dragging is not it: a drag cannot reliably
 * land on frame 120, and nothing on screen said which frame it had landed on either.
 *
 * The assertions are all about *which* number a change is about. The four values are two pairs, and
 * an edit that moved a clip when the user meant to lengthen it would be worse than no field at all.
 */

afterEach(cleanup);

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

function videoClip(start: number, duration: number, sourceIn = 100): VideoClip {
  return {
    kind: 'video',
    id: clipId('c1'),
    span: spanFromBounds(frameIndex(start), frameIndex(start + duration)),
    label: 'c1',
    enabled: true,
    effects: [],
    source: {
      asset: assetPath('media/x.mp4'),
      sourceIn: frameIndex(sourceIn),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
  };
}

function documentWith(clips: readonly Clip[]): TimelineDocument {
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
        track.kind === 'video' ? ({ ...track, clips } as typeof track) : track,
      ),
    },
  };
}

function mount(document = documentWith([videoClip(100, 90)])) {
  const onChange = vi.fn();
  const onReject = vi.fn();
  const clip = locateClip(document, clipId('c1'))!.clip;
  render(<ClipTiming document={document} clip={clip} onChange={onChange} onReject={onReject} />);
  return { onChange, onReject };
}

/** The clip as the last commit left it. */
function committed(onChange: ReturnType<typeof vi.fn>): Clip {
  const next = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
  return locateClip(next, clipId('c1'))!.clip;
}

async function type(field: string, value: string): Promise<void> {
  const user = userEvent.setup();
  const input = screen.getByLabelText(field);
  await user.clear(input);
  await user.type(input, `${value}{Enter}`);
}

describe('what it shows', () => {
  it('states where the clip is and how long it is', () => {
    mount();
    expect((screen.getByLabelText('start') as HTMLInputElement).value).toBe('100');
    expect((screen.getByLabelText('duration') as HTMLInputElement).value).toBe('90');
  });

  it('shows the end as a derived value rather than a fifth field', () => {
    // A field would be a second way to say "duration" that has to agree with the first.
    mount();
    expect(screen.getByText('190')).toBeTruthy();
    expect(screen.queryByLabelText('end')).toBeNull();
  });

  it('shows the timecode beside the frames, since an editor reads both', () => {
    mount();
    expect(screen.getAllByText(/00:00:03:10/).length).toBeGreaterThan(0);
  });

  it('offers no source field for a clip that has no source', () => {
    const text = {
      kind: 'text',
      id: clipId('c1'),
      span: spanFromBounds(frameIndex(0), frameIndex(30)),
      label: 'title',
      enabled: true,
      effects: [],
      content: { text: 'hi' },
    } as unknown as Clip;
    mount(documentWith([text]));
    expect(screen.queryByLabelText('source in')).toBeNull();
  });
});

describe('which number a change is about', () => {
  it('moves the clip when the start changes, keeping its length', async () => {
    const { onChange } = mount();
    await type('start', '150');

    const clip = committed(onChange);
    expect(clip.span.start).toBe(150);
    expect(clip.span.duration).toBe(90);
  });

  it('trims the tail when the duration changes, keeping the start', async () => {
    const { onChange } = mount();
    await type('duration', '40');

    const clip = committed(onChange);
    expect(clip.span.start).toBe(100);
    expect(clip.span.duration).toBe(40);
  });

  it('slips when the source in changes, leaving the clip where it is', async () => {
    // The spec's *csúsztatás*, which was reachable only by holding Alt while dragging.
    const { onChange } = mount();
    await type('source in', '120');

    const clip = committed(onChange);
    expect(clip.span.start).toBe(100);
    expect(clip.span.duration).toBe(90);
    expect(clip.kind === 'video' && clip.source.sourceIn).toBe(120);
  });
});

describe('refusals', () => {
  it('reports an overlap rather than silently doing nothing', async () => {
    // The same refusal dragging there produces: a typed edit and a dragged one are the same edit.
    const other = { ...videoClip(300, 60), id: clipId('c2'), label: 'c2' } as VideoClip;
    const { onReject } = mount(documentWith([videoClip(100, 90), other]));
    await type('start', '280');

    expect(onReject).toHaveBeenCalled();
    expect(String(onReject.mock.calls.at(-1)?.[0])).toContain('overlaps');
  });

  it('takes a linked partner along, as dragging the body does', async () => {
    // Moving a video and leaving its audio behind is the one outcome nobody wants.
    const video = { ...videoClip(100, 90), linkedAudio: clipId('a1') } as VideoClip;
    const audio = {
      kind: 'audio',
      id: clipId('a1'),
      span: spanFromBounds(frameIndex(100), frameIndex(190)),
      label: 'a1',
      enabled: true,
      effects: [],
      source: {
        asset: assetPath('media/x.mp4'),
        sourceIn: frameIndex(100),
        sourceRate: FRAME_RATES.WEB_30,
      },
      speed: { factor: 1, preservePitch: true },
      gain: staticNumber(1),
      pan: staticNumber(0),
      linkedVideo: clipId('c1'),
    } as AudioClip;

    const base = documentWith([video]);
    const document: TimelineDocument = {
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) =>
          track.kind === 'audio' ? ({ ...track, clips: [audio] } as typeof track) : track,
        ),
      },
    };

    const { onChange } = mount(document);
    await type('start', '150');

    const next = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
    expect(locateClip(next, clipId('c1'))?.clip.span.start).toBe(150);
    expect(locateClip(next, clipId('a1'))?.clip.span.start).toBe(150);
  });
});
