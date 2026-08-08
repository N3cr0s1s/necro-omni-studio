// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type TextClip,
  type TimelineDocument,
  type Track,
  FRAME_RATES,
  createDocument,
  isAnimated,
  keyframeCount,
  locateClip,
  projectId,
  sequenceId,
  trackId,
} from '@nos/core';
import { DEFAULT_TEXT_FRAMES, TextInspector, createTextClip } from './TextInspector.js';

afterEach(cleanup);

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

function documentWith(clips: readonly TextClip[]): TimelineDocument {
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
        track.kind === 'text' ? ({ ...track, clips } as Track) : track,
      ),
    },
  };
}

const withTitle = () => documentWith([createTextClip('t1', 0)]);

/** The clip as it is after a change, so a test asserts on the document rather than on a call shape. */
function afterChange(onChange: ReturnType<typeof vi.fn>): TextClip {
  const last = onChange.mock.calls.at(-1);
  if (last === undefined) throw new Error('nothing was committed');
  const located = locateClip(last[1] as TimelineDocument, 't1' as never);
  if (located === undefined || located.clip.kind !== 'text') throw new Error('the title is gone');
  return located.clip;
}

const renderInspector = (overrides: Partial<Parameters<typeof TextInspector>[0]> = {}) => {
  const onChange = vi.fn();
  render(<TextInspector document={withTitle()} clip="t1" onChange={onChange} {...overrides} />);
  return onChange;
};

describe('creating a title', () => {
  it('is legible without further work', () => {
    // A white title over bright footage is unreadable, and a title that disappears on some shots is
    // worse than one slightly heavier than necessary.
    const clip = createTextClip('t1', 0);
    expect(clip.content.shadow).toBeDefined();
    expect(clip.content.weight).toBeGreaterThanOrEqual(700);
  });

  it('lasts long enough to read', () => {
    expect(createTextClip('t1', 0).span.duration).toBe(DEFAULT_TEXT_FRAMES);
  });

  it('starts where it was asked to', () => {
    expect(createTextClip('t1', 240).span.start).toBe(240);
  });

  it('is neutral, so a preset animates from rest rather than from an authored offset', () => {
    const clip = createTextClip('t1', 0);
    expect(isAnimated(clip.transform.opacity)).toBe(false);
    expect(isAnimated(clip.transform.y)).toBe(false);
  });
});

describe('rendering', () => {
  it('shows nothing for a clip that is not text', () => {
    render(<TextInspector document={withTitle()} clip="nope" onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Text')).toBeNull();
  });

  it('shows the fields that decide what the rasterizer produces', () => {
    renderInspector();
    for (const field of ['Text', 'Size', 'Weight', 'Align', 'Colour']) {
      expect(screen.getByLabelText(field), field).toBeDefined();
    }
  });

  it('offers every animation preset the engine implements', () => {
    renderInspector();
    const options = [...screen.getByLabelText('Animate in').querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['none', 'fade', 'slide', 'scale', 'typewriter']);
  });

  it('offers a direction only for the preset that has one', () => {
    // A direction control on a fade is a question with no meaning, and offering meaningless controls
    // teaches users to ignore all of them.
    renderInspector();
    expect(screen.queryByLabelText('Animate in direction')).toBeNull();
  });
});

describe('editing content', () => {
  it('writes the text through', async () => {
    const user = userEvent.setup();
    const onChange = renderInspector();

    await user.type(screen.getByLabelText('Text'), '!');
    expect(afterChange(onChange).content.text).toBe('Title!');
  });

  it('keeps the clip label in step with the text', async () => {
    // A timeline of clips all labelled "Title" is unreadable, and nobody renames them by hand.
    const user = userEvent.setup();
    const onChange = renderInspector();

    await user.type(screen.getByLabelText('Text'), '!');
    expect(afterChange(onChange).label).toBe('Title!');
  });

  it('falls back to a name rather than an empty label', async () => {
    const user = userEvent.setup();
    const onChange = renderInspector();

    await user.clear(screen.getByLabelText('Text'));
    expect(afterChange(onChange).label).toBe('Title');
  });

  it('writes the size', () => {
    // One change event rather than keystrokes: the field is controlled by the document and a spy never
    // feeds the value back, so typing would append to the old size instead of replacing it. What is
    // under test is the write, not the browser's editing behaviour.
    const onChange = renderInspector();

    fireEvent.change(screen.getByLabelText('Size'), { target: { value: '96' } });
    expect(afterChange(onChange).content.size).toBe(96);
  });

  it('round trips a colour through the hex control', () => {
    // The document stores normalized channels because that is what a shader uniform wants; the control
    // speaks hex. A lossy conversion would drift the colour every time the panel is touched.
    const onChange = renderInspector();
    expect((screen.getByLabelText('Colour') as HTMLInputElement).value).toBe('#ffffff');

    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#3366cc' } });
    const { r, g, b, a } = afterChange(onChange).content.color;

    expect(r).toBeCloseTo(0x33 / 255, 5);
    expect(g).toBeCloseTo(0x66 / 255, 5);
    expect(b).toBeCloseTo(0xcc / 255, 5);
    // Alpha is not editable here, so it must survive untouched rather than being reset to opaque by
    // a conversion that only knows about three channels.
    expect(a).toBe(1);
  });
});

describe('presets generate keyframes', () => {
  it('writes them into the channels the preset touches', async () => {
    // The claim the panel makes in its own hint text, and the reason presets are worth having: what a
    // preset produced is editable like anything placed by hand.
    const user = userEvent.setup();
    const onChange = renderInspector();

    await user.selectOptions(screen.getByLabelText('Animate in'), 'slide');
    const clip = afterChange(onChange);

    expect(isAnimated(clip.transform.y)).toBe(true);
    expect(keyframeCount(clip.transform.y)).toBeGreaterThan(1);
  });

  it('leaves channels the preset does not touch alone', async () => {
    // Applying "slide in" must not silently pin a fade the user authored by hand.
    const user = userEvent.setup();
    const onChange = renderInspector();

    await user.selectOptions(screen.getByLabelText('Animate in'), 'slide');
    expect(isAnimated(afterChange(onChange).transform.scale)).toBe(false);
  });

  it('gives typewriter its own channel rather than a transform', async () => {
    // Typewriter changes the *number of visible glyphs*, which no transform can express.
    const user = userEvent.setup();
    const onChange = renderInspector();

    await user.selectOptions(screen.getByLabelText('Animate in'), 'typewriter');
    const clip = afterChange(onChange);

    expect(clip.reveal !== undefined && isAnimated(clip.reveal)).toBe(true);
  });

  it('records the animation, so reopening the panel shows what was chosen', async () => {
    const user = userEvent.setup();
    const onChange = renderInspector();

    await user.selectOptions(screen.getByLabelText('Animate in'), 'fade');
    expect(afterChange(onChange).animateIn?.preset).toBe('fade');
  });

  it('keeps the in and out animations separate', async () => {
    const user = userEvent.setup();
    const onChange = renderInspector();

    await user.selectOptions(screen.getByLabelText('Animate out'), 'fade');
    const clip = afterChange(onChange);

    expect(clip.animateOut?.preset).toBe('fade');
    expect(clip.animateIn).toBeUndefined();
  });

  it('shows the direction control once a slide is chosen', async () => {
    const user = userEvent.setup();
    render(
      <TextInspector
        document={documentWith([
          {
            ...createTextClip('t1', 0),
            animateIn: { preset: 'slide', direction: 'up', durationFrames: 12, ease: 'ease-out' },
          },
        ])}
        clip="t1"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText('Animate in'));
    expect(screen.getByLabelText('Animate in direction')).toBeDefined();
  });

  it('says that a preset writes editable keyframes, since that is not obvious', () => {
    renderInspector();
    expect(screen.getByText(/preset writes keyframes/)).toBeDefined();
  });
});
