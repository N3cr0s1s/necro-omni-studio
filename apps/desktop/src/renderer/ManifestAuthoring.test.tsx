// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManifestAuthoring } from './ManifestAuthoring.js';

/**
 * Saving an authored manifest.
 *
 * A manifest is written to `generators/<id>.manifest.json`, so the id *is* the filename and two
 * generators cannot share one. This screen wrote that path with no check: typing an id the library
 * already had replaced a working generator — including one that ships with the project — silently and
 * completely. An id is a short slug with nothing on screen to say what is taken, so it is not an
 * exotic mistake.
 *
 * Driven through the screen rather than asserted on `saveTarget`, because a warning wired to nothing
 * looks identical from the outside.
 */

afterEach(cleanup);

const library = new Set(['stable_audio_3', 'krea2_img2img']);

function open(overrides: Partial<Parameters<typeof ManifestAuthoring>[0]> = {}) {
  return render(<ManifestAuthoring graphs={new Map()} onClose={vi.fn()} onSaved={vi.fn()} {...overrides} />);
}

/** The id field lives in the inspector this screen wraps; typed as a user would reach it. */
async function typeId(id: string): Promise<void> {
  const field = screen.getByLabelText('Id');
  await userEvent.clear(field);
  await userEvent.type(field, id);
}

describe('an id the library already has', () => {
  it('says what saving would replace', async () => {
    open({ takenIds: library });
    await typeId('stable_audio_3');
    expect(screen.getByText(/saving replaces the stable_audio_3 manifest/)).toBeDefined();
  });

  it('says nothing about an id nothing has taken', async () => {
    open({ takenIds: library });
    await typeId('fish_s2');
    expect(screen.queryByText(/saving replaces/)).toBeNull();
  });

  it('says nothing when the library has not been read', async () => {
    // Absent means "not known", not "nothing is taken": a screen that has not seen the library must
    // not claim an id is free.
    open();
    await typeId('stable_audio_3');
    expect(screen.queryByText(/saving replaces/)).toBeNull();
  });

  it('says nothing about the manifest that was opened, because replacing it is the point', async () => {
    open({ takenIds: library, editingId: 'stable_audio_3' });
    await typeId('stable_audio_3');
    expect(screen.queryByText(/saving replaces/)).toBeNull();
  });

  it('warns when an opened manifest is renamed onto another', async () => {
    // Renaming is authoring a new manifest under a taken name, which is why the screen is told *which*
    // id it opened rather than merely that it opened one.
    open({ takenIds: library, editingId: 'stable_audio_3' });
    await typeId('krea2_img2img');
    expect(screen.getByText(/saving replaces the krea2_img2img manifest/)).toBeDefined();
  });

  it('offers a free id, and taking it clears the warning', async () => {
    // A warning rather than a refusal — replacing on purpose is exactly what saving one you opened is
    // — so what matters is that there is one click out of it.
    open({ takenIds: library });
    await typeId('stable_audio_3');

    await userEvent.click(screen.getByRole('button', { name: 'Save as stable_audio_3_2' }));

    expect(screen.queryByText(/saving replaces/)).toBeNull();
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('stable_audio_3_2');
  });
});

describe('where it actually writes', () => {
  /**
   * The check and the write have to name the same file.
   *
   * Nothing in the type system connects "the id this warned about" to "the path this wrote", so the
   * two can drift into a screen that warns about one manifest and replaces another. Asserting the
   * path is the only thing that holds them together.
   */
  function stubBridge(): { readonly written: string[] } {
    const written: string[] = [];
    (globalThis as { nos?: unknown }).nos = {
      writeTextFile: (path: string) => {
        written.push(path);
        return Promise.resolve();
      },
    };
    return { written };
  }

  afterEach(() => {
    delete (globalThis as { nos?: unknown }).nos;
  });

  /**
   * Enough of a draft that Save is not blocked.
   *
   * `draftHasErrors` gates it, and an empty draft has three errors — no id, no name, no output. That
   * gate is right, and it is also why the first version of this test clicked a disabled button and
   * read an empty list.
   */
  async function completeDraft(id: string): Promise<void> {
    await typeId(id);
    await userEvent.type(screen.getByLabelText('Name'), 'A generator');
    await userEvent.click(screen.getByRole('button', { name: 'Add output' }));
  }

  it('writes the file its own naming rule produced', async () => {
    const bridge = stubBridge();
    open({ takenIds: library });
    await completeDraft('fish_s2');

    await userEvent.click(screen.getByRole('button', { name: 'Save manifest' }));

    await vi.waitFor(() => expect(bridge.written).toEqual(['generators/fish_s2.manifest.json']));
  });

  it('writes the free id once it has been taken, not the one that was warned about', async () => {
    // The failure this guards: warning about `stable_audio_3`, offering a free id, and then writing
    // over `stable_audio_3` anyway.
    const bridge = stubBridge();
    open({ takenIds: library });
    await completeDraft('stable_audio_3');
    await userEvent.click(screen.getByRole('button', { name: 'Save as stable_audio_3_2' }));

    await userEvent.click(screen.getByRole('button', { name: 'Save manifest' }));

    await vi.waitFor(() => expect(bridge.written).toEqual(['generators/stable_audio_3_2.manifest.json']));
  });
});
