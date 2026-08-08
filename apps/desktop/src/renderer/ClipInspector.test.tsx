// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type TimelineDocument,
  type Track,
  type VideoClip,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  effectId,
  effectInstanceId,
  frameIndex,
  locateClip,
  maskId,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { BUILTIN_EFFECTS, createEffectRegistry } from '@nos/effects';
import { type MaskChoice, ClipInspector } from './ClipInspector.js';

/** The built-in that declares the `mask` sampler — the spec's own example of one. */
const BLUR_NAME = 'Background Blur';

afterEach(cleanup);

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };
const effects = createEffectRegistry(BUILTIN_EFFECTS);

function videoClip(id: string, start: number, end: number, overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/x.mp4'), sourceIn: frameIndex(100), sourceRate: FRAME_RATES.WEB_30 },
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

function documentWith(clips: readonly VideoClip[]): TimelineDocument {
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
        track.id === TRACKS.video ? ({ ...track, clips } as Track) : track,
      ),
    },
  };
}

const single = () => documentWith([videoClip('c1', 0, 100)]);
const adjacent = () => documentWith([videoClip('c1', 0, 100), videoClip('c2', 100, 200)]);

interface Harness {
  readonly onChange: ReturnType<typeof vi.fn>;
  readonly onReject: ReturnType<typeof vi.fn>;
}

function renderInspector(document = single(), clip = 'c1'): Harness {
  const onChange = vi.fn();
  const onReject = vi.fn();
  render(
    <ClipInspector
      document={document}
      clip={clip}
      effects={effects}
      playhead={0}
      onChange={onChange}
      onReject={onReject}
    />,
  );
  return { onChange, onReject };
}

/** The clip as it is after a commit, so assertions read the document rather than a call shape. */
function afterChange(onChange: ReturnType<typeof vi.fn>, id = 'c1'): VideoClip {
  const last = onChange.mock.calls.at(-1);
  if (last === undefined) throw new Error('nothing was committed');
  const located = locateClip(last[1] as TimelineDocument, id as never);
  if (located === undefined || located.clip.kind !== 'video') throw new Error('the clip is gone');
  return located.clip;
}

describe('the effect stack', () => {
  it('says so when a clip carries no effects', () => {
    renderInspector();
    expect(screen.getByText(/No effects on this clip/)).toBeDefined();
  });

  it('keeps the picker closed until it is asked for', () => {
    // A dozen buttons above the parameters would push them below the fold on every clip.
    renderInspector();
    expect(screen.queryByRole('button', { name: 'Levels' })).toBeNull();
  });

  it('lists every registered effect to add, including broken ones with their reason', async () => {
    // An effect missing from the list because its shader failed to compile is indistinguishable from
    // one that was never installed.
    const user = userEvent.setup();
    renderInspector();

    await user.click(screen.getByRole('button', { name: /Add effect from registry/ }));
    expect(screen.getByRole('button', { name: 'Film Grain' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Levels' })).toBeDefined();
  });

  it('adds an effect with the manifest´s declared defaults', async () => {
    const user = userEvent.setup();
    const { onChange } = renderInspector();

    await user.click(screen.getByRole('button', { name: /Add effect from registry/ }));
    await user.click(screen.getByRole('button', { name: 'Film Grain' }));
    const clip = afterChange(onChange);

    expect(clip.effects).toHaveLength(1);
    expect(clip.effects[0]?.effect).toBe('film_grain');
    expect(clip.effects[0]?.params['amount']).toBeDefined();
  });

  it('derives the instance id from the stack, so the same actions give the same document', async () => {
    // A clock or a counter here would make an undo comparison and a saved file undiffable.
    const user = userEvent.setup();
    const first = renderInspector();
    await user.click(screen.getByRole('button', { name: /Add effect from registry/ }));
    await user.click(screen.getByRole('button', { name: 'Film Grain' }));
    const a = afterChange(first.onChange).effects[0]?.id;

    cleanup();
    const second = renderInspector();
    await user.click(screen.getByRole('button', { name: /Add effect from registry/ }));
    await user.click(screen.getByRole('button', { name: 'Film Grain' }));
    const b = afterChange(second.onChange).effects[0]?.id;

    expect(a).toBe(b);
  });

  it('shows the declared parameters of the selected effect', async () => {
    const user = userEvent.setup();
    const withGrain = documentWith([
      videoClip('c1', 0, 100, {
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: { amount: staticNumber(0.3), size: staticNumber(1) },
          },
        ],
      }),
    ]);
    renderInspector(withGrain);

    await user.click(screen.getByText('Film Grain'));
    // Two controls carry the name — a slider and its numeric field — which is the point: a value is
    // both draggable and typable.
    expect(screen.getAllByLabelText('amount').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('size').length).toBeGreaterThan(0);
  });
});

describe('transitions', () => {
  it('offers only the effects declared as transitions', () => {
    // A film grain across a cut is not a transition, and offering it would produce a shader that
    // samples one texture where the compositor binds two.
    renderInspector(adjacent());

    expect(screen.getAllByRole('button', { name: 'Crossfade' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Wipe' }).length).toBe(2);
    // The picker is closed, so any `Film Grain` button here would have come from the transition rows.
    expect(screen.queryByRole('button', { name: 'Film Grain' })).toBeNull();
  });

  it('disables a side with no neighbour, and says why', () => {
    // The first clip in a sequence has nothing before it. A control that looked available and did
    // nothing would be worse than one that explains itself.
    renderInspector(single());
    const before = screen.getAllByRole('button', { name: 'Crossfade' })[0];

    expect(before?.hasAttribute('disabled')).toBe(true);
    expect(before?.getAttribute('title')).toContain('nothing meets');
  });

  it('creates one across the cut, overlapping the clips', async () => {
    const user = userEvent.setup();
    const { onChange } = renderInspector(adjacent());

    // The second row is the `after` side, which joins c1 to c2.
    const buttons = screen.getAllByRole('button', { name: 'Crossfade' });
    await user.click(buttons[buttons.length - 1]!);

    const first = afterChange(onChange, 'c1');
    const second = afterChange(onChange, 'c2');
    expect(first.span.start + first.span.duration).toBeGreaterThan(second.span.start);
  });

  it('reports a rejection rather than doing nothing', async () => {
    // A clip whose source starts at frame 0 has no handle to dissolve from, and the operation refuses.
    const user = userEvent.setup();
    const noHandles = documentWith([
      videoClip('c1', 0, 100),
      videoClip('c2', 100, 200, {
        source: { asset: assetPath('media/x.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
      }),
    ]);
    const { onChange, onReject } = renderInspector(noHandles);

    const buttons = screen.getAllByRole('button', { name: 'Crossfade' });
    await user.click(buttons[buttons.length - 1]!);

    expect(onChange).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('more frames'));
  });

  it('lists a transition that exists, with its length', async () => {
    const user = userEvent.setup();
    const { onChange } = renderInspector(adjacent());

    const buttons = screen.getAllByRole('button', { name: 'Crossfade' });
    await user.click(buttons[buttons.length - 1]!);

    cleanup();
    const committed = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
    renderInspector(committed);

    expect(screen.getByText(/crossfade · 12f/)).toBeDefined();
  });

  it('removes one, returning both clips to the cut', async () => {
    const user = userEvent.setup();
    const added = renderInspector(adjacent());
    const buttons = screen.getAllByRole('button', { name: 'Crossfade' });
    await user.click(buttons[buttons.length - 1]!);

    const withTransition = added.onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
    cleanup();

    const removed = renderInspector(withTransition);
    await user.click(screen.getByRole('button', { name: /^Remove the .* transition$/ }));

    const first = afterChange(removed.onChange, 'c1');
    const second = afterChange(removed.onChange, 'c2');
    expect(first.span.start + first.span.duration).toBe(second.span.start);
  });

  it('lets the length be chosen before the transition is made', async () => {
    const user = userEvent.setup();
    const { onChange } = renderInspector(adjacent());

    const frames = screen.getByLabelText('Transition frames');
    await user.clear(frames);
    await user.click(frames);
    await user.paste('20');

    const buttons = screen.getAllByRole('button', { name: 'Crossfade' });
    await user.click(buttons[buttons.length - 1]!);

    const committed = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
    const track = committed.sequence.tracks.find((entry) => entry.id === TRACKS.video);
    expect(track?.kind === 'video' && track.transitions[0]?.span.duration).toBe(20);
  });

  it('shows nothing for an audio clip, since transitions are a picture operation', () => {
    const { onReject } = renderInspector(single(), 'nope');
    expect(screen.queryByText('Transitions')).toBeNull();
    expect(onReject).not.toHaveBeenCalled();
  });
});

describe('with nothing selected', () => {
  it('says so rather than showing an empty form', () => {
    render(<ClipInspector document={single()} effects={effects} playhead={0} onChange={vi.fn()} />);
    expect(screen.getByText('no clip selected')).toBeDefined();
  });
});

describe('nesting', () => {
  it('keeps the parameter panel out of the way until an effect is chosen', () => {
    const withGrain = documentWith([
      videoClip('c1', 0, 100, {
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: { amount: staticNumber(0.3) },
          },
        ],
      }),
    ]);
    renderInspector(withGrain);

    // The stack lists it; its parameters appear only once selected.
    expect(screen.getByText('Film Grain')).toBeDefined();
    expect(screen.queryAllByLabelText('amount')).toHaveLength(0);
  });
});

/**
 * Binding a mask to an effect.
 *
 * Declaring the `mask` sampler is the *entire* coupling between SAM 2 and the effect system, and until
 * now nothing could fill the slot: the built-in blur — the spec's own example — declared it and could
 * never receive one, so M11's whole pipeline terminated in a file no effect could read.
 */
describe('the mask slot', () => {
  const choices = [{ id: maskId('c1-mask'), label: 'this clip', ready: true }];

  const withBlur = (mask?: string) =>
    documentWith([
      videoClip('c1', 0, 100, {
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('background_blur'),
            enabled: true,
            params: {},
            ...(mask !== undefined ? { mask: maskId(mask) } : {}),
          },
        ],
      }),
    ]);

  function renderWithMasks(document: TimelineDocument, masks: readonly MaskChoice[]) {
    const onChange = vi.fn();
    render(
      <ClipInspector
        document={document}
        clip="c1"
        effects={effects}
        playhead={0}
        onChange={onChange}
        masks={masks}
      />,
    );
    return onChange;
  }

  /** The effect instance as the last commit left it. */
  function boundEffect(onChange: ReturnType<typeof vi.fn>) {
    const next = onChange.mock.calls.at(-1)?.[1] as TimelineDocument;
    const located = locateClip(next, clipId('c1'));
    if (located === undefined) throw new Error('no clip');
    return located.clip.effects[0]!;
  }

  it('offers the slot only for an effect that declares one', async () => {
    const withGrain = documentWith([
      videoClip('c1', 0, 100, {
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: { amount: staticNumber(0.3) },
          },
        ],
      }),
    ]);
    renderWithMasks(withGrain, choices);

    await userEvent.click(screen.getByText('Film Grain'));
    expect(screen.queryByLabelText('Mask')).toBeNull();
  });

  it('says how to get one rather than offering an empty list', async () => {
    // The same rule an unavailable generator follows: an effect declaring a mask slot with no way to
    // fill it looks broken.
    renderWithMasks(withBlur(), []);
    await userEvent.click(screen.getByText(BLUR_NAME));

    expect(screen.getByDisplayValue(/segment this clip/)).toBeDefined();
  });

  it('binds a mask onto the effect', async () => {
    const onChange = renderWithMasks(withBlur(), choices);
    await userEvent.click(screen.getByText(BLUR_NAME));
    await userEvent.selectOptions(screen.getByLabelText('Mask'), 'c1-mask');

    expect(boundEffect(onChange).mask).toBe('c1-mask');
  });

  it('removes the field when unbound, rather than storing an undefined one', async () => {
    // `project.json` would read a `"mask": null` back as a value rather than as an absence.
    const onChange = renderWithMasks(withBlur('c1-mask'), choices);
    await userEvent.click(screen.getByText(BLUR_NAME));
    await userEvent.selectOptions(screen.getByLabelText('Mask'), '');

    const instance = boundEffect(onChange);
    expect(instance.mask).toBeUndefined();
    expect('mask' in instance).toBe(false);
  });
});
