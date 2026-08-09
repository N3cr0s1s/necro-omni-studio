// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FRAME_RATES,
  type TimelineDocument,
  assetPath,
  createDocument,
  frameIndex,
  projectId,
  sequenceId,
  trackId,
} from '@nos/core';
import { addBeat, editBeat } from '@nos/editing';
import { StoryTab } from './StoryTab.js';

/**
 * The story board tab, per issue #33.
 *
 * Rendered *live* — the document lives in state and every commit lands back on the props, the way App
 * holds it. A mocked `onChangeDocument` would let a typed character disappear into a field that
 * re-renders to its old value, and every one of these tests would still pass.
 */

afterEach(cleanup);

const emptyDocument = (): TimelineDocument =>
  createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'plan',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

function renderLive(initial: TimelineDocument, attachable?: string) {
  const labels: string[] = [];

  function Harness() {
    const [document, setDocument] = useState(initial);
    return (
      <StoryTab
        document={document}
        playhead={frameIndex(0)}
        onChangeDocument={(label, next) => {
          labels.push(label);
          setDocument(next);
        }}
        onSeek={() => undefined}
        {...(attachable !== undefined ? { attachable: assetPath(attachable) } : {})}
      />
    );
  }

  render(<Harness />);
  return { labels };
}

describe('a board with no project', () => {
  it('says the board belongs to the project rather than rendering an empty plan', () => {
    render(
      <StoryTab
        document={undefined}
        playhead={frameIndex(0)}
        onChangeDocument={() => undefined}
        onSeek={() => undefined}
      />,
    );
    expect(screen.queryByText('No project open')).not.toBeNull();
  });
});

describe('adding a beat', () => {
  it('puts one on the board and commits it under a name undo can show', async () => {
    const { labels } = renderLive(emptyDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Add beat' }));

    expect(screen.queryByLabelText('Untitled beat')).not.toBeNull();
    expect(labels).toEqual(['add beat']);
  });

  it('selects it, because a beat is added in order to write it', async () => {
    renderLive(emptyDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Add beat' }));

    // The editor is showing rather than the "select a beat" prompt.
    expect(screen.queryByLabelText('Title')).not.toBeNull();
  });

  it('says what a beat is for while the board is empty', () => {
    renderLive(emptyDocument());
    expect(screen.queryByText(/the text a prompt is/i)).not.toBeNull();
  });
});

describe('writing a beat', () => {
  const withBeat = () => addBeat(emptyDocument(), frameIndex(0));

  it('keeps every character typed into the title', async () => {
    renderLive(withBeat());
    await userEvent.click(screen.getByLabelText('Untitled beat'));
    await userEvent.type(screen.getByLabelText('Title'), 'Wide shot');

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Wide shot');
  });

  it('shows the title on the block as it is typed', async () => {
    renderLive(withBeat());
    await userEvent.click(screen.getByLabelText('Untitled beat'));
    await userEvent.type(screen.getByLabelText('Title'), 'Dunes');

    expect(screen.queryByLabelText('Dunes')).not.toBeNull();
  });

  it('keeps every character typed into the notes', async () => {
    renderLive(withBeat());
    await userEvent.click(screen.getByLabelText('Untitled beat'));
    await userEvent.type(screen.getByLabelText('Notes'), '# Late light');

    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('# Late light');
  });

  it('sets an accent', async () => {
    renderLive(withBeat());
    await userEvent.click(screen.getByLabelText('Untitled beat'));
    await userEvent.click(screen.getByLabelText('Accent 3'));

    expect(screen.getByLabelText('Accent 3').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('removing a beat', () => {
  it('is offered only once one is selected', () => {
    renderLive(addBeat(emptyDocument(), frameIndex(0)));
    expect((screen.getByRole('button', { name: /delete/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('takes it off the board', async () => {
    renderLive(addBeat(emptyDocument(), frameIndex(0)));
    await userEvent.click(screen.getByLabelText('Untitled beat'));
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(screen.queryByLabelText('Untitled beat')).toBeNull();
  });
});

describe('references', () => {
  const withBeat = () => addBeat(emptyDocument(), frameIndex(0));

  it('names the file it would attach, rather than making you press it to find out', async () => {
    renderLive(withBeat(), 'media/dune.png');
    await userEvent.click(screen.getByLabelText('Untitled beat'));

    expect(
      (screen.getByRole('button', { name: /attach media\/dune\.png/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('says what to do when nothing is selected instead of offering a button that does nothing', async () => {
    renderLive(withBeat());
    await userEvent.click(screen.getByLabelText('Untitled beat'));

    expect(
      (screen.getByRole('button', { name: /select a file to attach/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('attaches the browser’s selection and lists it', async () => {
    renderLive(withBeat(), 'media/dune.png');
    await userEvent.click(screen.getByLabelText('Untitled beat'));
    await userEvent.click(screen.getByRole('button', { name: /attach media\/dune\.png/i }));

    const beat = screen.getByLabelText('Beat');
    expect(within(beat).queryByRole('button', { name: 'Detach media/dune.png' })).not.toBeNull();
  });

  it('detaches one', async () => {
    renderLive(withBeat(), 'media/dune.png');
    await userEvent.click(screen.getByLabelText('Untitled beat'));
    await userEvent.click(screen.getByRole('button', { name: /attach media\/dune\.png/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Detach media/dune.png' }));

    expect(screen.queryByRole('button', { name: 'Detach media/dune.png' })).toBeNull();
  });
});

describe('the order the beats happen in', () => {
  it('is listed even when the board stacks them on separate rows', () => {
    // Overlapping beats sit on different rows, and a plan is still read top to bottom.
    const two = editBeat(
      addBeat(addBeat(emptyDocument(), frameIndex(0)), frameIndex(30)),
      addBeat(emptyDocument(), frameIndex(0)).story[0]!.id,
      { title: 'First' },
    );
    renderLive(two);

    expect(screen.getAllByText('First').length).toBeGreaterThan(0);
  });
});
