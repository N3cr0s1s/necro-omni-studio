// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectAuthoring } from './EffectAuthoring.js';

/**
 * Writing an effect.
 *
 * Issue #28. The format existed and the authoring did not: a text editor, a guess at the schema, a
 * reload, and a drag onto a clip to find out whether it compiled.
 *
 * jsdom has no WebGL2, so the preview reports itself unavailable here rather than drawing — which is
 * deliberately *not* the same as a compile failure, and one of the things asserted. What the preview
 * does on a real driver belongs to `glcheck` and to driving the running application.
 */

afterEach(cleanup);

function open(overrides: Partial<Parameters<typeof EffectAuthoring>[0]> = {}) {
  return render(<EffectAuthoring onClose={vi.fn()} onSaved={vi.fn()} {...overrides} />);
}

/** Records what reaches the bridge, which is the only place the two files can be observed. */
function stubBridge(): { readonly writes: { path: string; contents: string }[] } {
  const writes: { path: string; contents: string }[] = [];
  (globalThis as { nos?: unknown }).nos = {
    writeTextFile: (path: string, contents: string) => {
      writes.push({ path, contents });
      return Promise.resolve();
    },
  };
  return { writes };
}

afterEach(() => {
  delete (globalThis as { nos?: unknown }).nos;
});

describe('a new effect', () => {
  it('opens an editor for the shader it will save', async () => {
    /*
     * What the *component* owns after issue #35: mounting the editor, on the file the effect will
     * become. That the starter shader already compiles is the draft's claim and is asserted where
     * the draft is — `effect-draft.test.ts` — rather than a second time through the DOM.
     *
     * The editor is loaded lazily, so what is on screen first is the placeholder, which must still
     * name the file or opening one would look like nothing happening.
     */
    open();
    expect(await screen.findByText(/opening effects\/untitled\.frag/u)).not.toBeNull();
  });

  it('will not save without an id and a name', () => {
    open();
    expect(screen.getByRole('button', { name: 'Save effect' }).hasAttribute('disabled')).toBe(true);
  });

  it('says what is missing rather than only disabling the button', () => {
    // A greyed button with no reason is the thing this panel exists not to be.
    open();
    expect(screen.getByText(/an id is required/)).toBeDefined();
    expect(screen.getByText(/a name is required/)).toBeDefined();
  });
});

describe('what it writes', () => {
  async function fill(id: string, name: string): Promise<void> {
    await userEvent.type(screen.getByLabelText('Id'), id);
    await userEvent.type(screen.getByLabelText('Name'), name);
  }

  it('writes both files, named from the id', async () => {
    const bridge = stubBridge();
    open();
    await fill('film_grain', 'Film grain');

    await userEvent.click(screen.getByRole('button', { name: 'Save effect' }));

    await vi.waitFor(() =>
      expect(bridge.writes.map((write) => write.path)).toEqual([
        'effects/film_grain.frag',
        'effects/film_grain.json',
      ]),
    );
  });

  it('writes the shader before the manifest', async () => {
    /*
     * A manifest naming a shader that is not there is a *broken* effect in the registry; a shader
     * nothing names is a file nobody reads. If the second write fails, the worse of the two states is
     * the one that did not happen.
     */
    const bridge = stubBridge();
    open();
    await fill('film_grain', 'Film grain');

    await userEvent.click(screen.getByRole('button', { name: 'Save effect' }));

    await vi.waitFor(() => expect(bridge.writes).toHaveLength(2));
    expect(bridge.writes[0]?.path.endsWith('.frag')).toBe(true);
  });

  it('writes a manifest naming the shader beside it', async () => {
    const bridge = stubBridge();
    open();
    await fill('film_grain', 'Film grain');

    await userEvent.click(screen.getByRole('button', { name: 'Save effect' }));

    await vi.waitFor(() => expect(bridge.writes).toHaveLength(2));
    const manifest = JSON.parse(bridge.writes[1]?.contents ?? '{}') as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: 'film_grain',
      name: 'Film grain',
      category: 'effect',
      shader: 'film_grain.frag',
      samplers: ['source'],
    });
  });
});

describe('replacing one that is already there', () => {
  const existing = [
    {
      manifest: {
        id: 'film_grain',
        name: 'Film grain',
        category: 'effect',
        shader: 'film_grain.frag',
        samplers: ['source'],
        params: [],
      },
      shader: 'void main(){ fragColor = texture(source, v_uv); }',
    },
  ] as never;

  it('says so before it happens', async () => {
    open({ existing });
    await userEvent.type(screen.getByLabelText('Id'), 'film_grain');
    expect(screen.getByText(/saving replaces the film_grain effect/)).toBeDefined();
  });

  it('says nothing about the one that was opened, because replacing it is the point', async () => {
    open({ existing, editing: 'film_grain' });
    expect(screen.queryByText(/saving replaces/)).toBeNull();
  });

  it('reopens on that effect’s own file, so its undo history follows it', async () => {
    // Monaco keys a model — and therefore an undo stack — by path. Reopening an effect under the
    // file it was saved as is what makes closing and reopening the tab keep the history.
    open({ existing, editing: 'film_grain' });
    expect(await screen.findByText(/opening effects\/film_grain\.frag/u)).not.toBeNull();
  });
});

describe('parameters', () => {
  it('warns when the shader never reads one', async () => {
    // The control appears and does nothing, which is the bug an editor holding both files exists to
    // catch — and it is a warning, since the next keystroke may be the one that uses it.
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(screen.getByText(/the shader never reads "param_1"/)).toBeDefined();
  });

  it('does not block saving on it', async () => {
    const bridge = stubBridge();
    open();
    await userEvent.type(screen.getByLabelText('Id'), 'x');
    await userEvent.type(screen.getByLabelText('Name'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Add parameter' }));

    await userEvent.click(screen.getByRole('button', { name: 'Save effect' }));

    await vi.waitFor(() => expect(bridge.writes).toHaveLength(2));
  });

  it('says which types can be keyframed, since that is usually why one is chosen', () => {
    open();
    void userEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    return vi.waitFor(() => {
      const options = [...(screen.getByLabelText('Type') as HTMLSelectElement).options].map(
        (option) => option.text,
      );
      expect(options).toContain('float · keyframable');
      expect(options).toContain('bool');
    });
  });
});

describe('changing what kind it is', () => {
  it('changes the samplers with it', async () => {
    /*
     * The samplers are what the compositor binds: an effect reads the frame so far, a transition reads
     * the two it blends. Left alone, switching kind produced a transition reading `source`, which
     * compiles and renders nothing.
     */
    open();
    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'transition');
    expect(screen.getByText(/the shader never reads "from"/)).toBeDefined();
  });
});
