// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
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
import { Timeline } from './Timeline.js';
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
    renderTimeline({ rippleEnabled: false });
    expect(screen.getByRole('button', { name: 'Ripple' }).getAttribute('aria-pressed')).toBeNull();
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
    expect((layer as HTMLElement | null)?.style.overflow).toBe('hidden');
  });

  it('gives a waveform the whole clip and a filmstrip a band', () => {
    // Different jobs: a waveform *is* the clip's content, a filmstrip sits under a label that has to
    // stay readable.
    const doc = makeDocument([video('a', 0, 300)]);
    const strips = new Map([['a', { url: 'file:strip.jpg', widths: 1, offset: 0 }]]);
    renderTimeline({ document: doc, strips });

    const layer = document.querySelector('[data-clip-id="a"] [data-strip-kind]') as HTMLElement;
    expect(layer.dataset['stripKind']).toBe('filmstrip');
    expect(layer.style.height).toBe('34px');
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
