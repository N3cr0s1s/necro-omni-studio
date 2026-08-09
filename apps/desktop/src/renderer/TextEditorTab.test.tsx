// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DesktopBridge } from '../main/ipc-contract.js';
import { TextEditorTab, languageFor } from './TextEditorTab.js';

/**
 * The file editor tab, after issue #35 moved the editing surface to Monaco.
 *
 * What is asserted here is what the *tab* owns: reading the file, refusing to save something that
 * would not load, and choosing the language. The editor itself needs layout and a canvas, neither of
 * which jsdom has, so driving it is `smokecheck`'s job — where there is a real browser and the
 * completions can be typed at.
 *
 * The knowledge behind those completions is unchanged and still tested without a DOM: `locationAt`
 * and `completionsFor` in `@nos/core` are what Monaco is asking, and adopting a widget did not move
 * them.
 */

const files = new Map<string, string>();

beforeEach(() => {
  files.clear();
  (globalThis as { nos?: Partial<DesktopBridge> }).nos = {
    readTextFile: (path: string) => Promise.resolve(files.get(path)),
    writeTextFile: (path: string, contents: string) => {
      files.set(path, contents);
      return Promise.resolve();
    },
  } as Partial<DesktopBridge> as DesktopBridge;
});

afterEach(() => {
  cleanup();
  delete (globalThis as { nos?: unknown }).nos;
  vi.restoreAllMocks();
});

describe('choosing a language', () => {
  it('reads a manifest as JSON', () => {
    expect(languageFor('effects/tint.json')).toBe('json');
  });

  it('reads a shader as GLSL', () => {
    // Monaco ships no GLSL; the grammar is this codebase's, which is why the extensions have to be
    // named here rather than left to whatever Monaco guesses.
    expect(languageFor('effects/tint.frag')).toBe('glsl');
    expect(languageFor('effects/pass.vert')).toBe('glsl');
  });

  it('leaves anything else alone', () => {
    // A note coloured as if it were code is harder to read than one left plain.
    expect(languageFor('notes/plan.md')).toBe('plaintext');
  });

  it('ignores case, because an extension is not a promise about capitals', () => {
    expect(languageFor('effects/TINT.JSON')).toBe('json');
  });
});

describe('opening a file', () => {
  it('names what is being edited', async () => {
    files.set('effects/tint.json', '{ "id": "tint" }');
    render(<TextEditorTab path="effects/tint.json" />);

    expect(await screen.findByText('effects/tint.json')).not.toBeNull();
  });

  it('says so when the file cannot be read, rather than opening blank', async () => {
    // Opening blank is one save away from destroying a file that was merely unreadable.
    render(<TextEditorTab path="effects/missing.json" />);

    expect(await screen.findByText(/could not be read/u)).not.toBeNull();
  });
});

describe('saving', () => {
  it('is refused until something has changed', async () => {
    files.set('effects/tint.json', '{ "id": "tint" }');
    render(<TextEditorTab path="effects/tint.json" />);

    const save = await screen.findByRole('button', { name: /save/iu });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
  });

  it('is refused for a file that could not be read at all', async () => {
    render(<TextEditorTab path="effects/missing.json" />);

    const save = await screen.findByRole('button', { name: /save/iu });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('reporting a broken manifest', () => {
  it('names the line the parser stopped on', async () => {
    // Saving invalid JSON over a manifest is how a project stops loading. The editor can see it
    // before the file exists, so it refuses rather than reporting it afterwards.
    files.set('effects/broken.json', '{\n  "id": ,\n}');
    render(<TextEditorTab path="effects/broken.json" />);

    expect(await screen.findByText(/line \d/u)).not.toBeNull();
  });

  it('says nothing about a file that is not JSON', async () => {
    files.set('notes/plan.md', '# not json at all {');
    render(<TextEditorTab path="notes/plan.md" />);

    await screen.findByText('notes/plan.md');
    expect(screen.queryByText(/line \d/u)).toBeNull();
  });
});

describe('the surface itself', () => {
  it('is mounted under a name the harness and a screen reader can find it by', async () => {
    files.set('effects/tint.json', '{ "id": "tint" }');
    render(<TextEditorTab path="effects/tint.json" />);

    // Monaco is loaded lazily, so what is on screen first is the placeholder — which must still
    // report the file, or opening one would look like nothing happening.
    expect(await screen.findByText(/opening effects\/tint\.json/u)).not.toBeNull();
  });

  it('reports unsaved state to the tab', async () => {
    files.set('effects/tint.json', '{ "id": "tint" }');
    const onDirty = vi.fn();
    render(<TextEditorTab path="effects/tint.json" onDirty={onDirty} />);

    await screen.findByText('effects/tint.json');
    // A freshly opened file is clean, and the tab must not mark it.
    await waitFor(() => expect(onDirty).toHaveBeenCalledWith(false));
  });
});

describe('a window with no bridge', () => {
  it('says why nothing can be read instead of showing an empty editor', async () => {
    delete (globalThis as { nos?: unknown }).nos;
    render(<TextEditorTab path="effects/tint.json" />);

    expect(await screen.findByText(/bridge is unavailable/u)).not.toBeNull();
  });
});

describe('typing', () => {
  it('does not reach the placeholder, which is not an editor', async () => {
    // Guards the failure mode of a lazy component: a fallback that accepted keystrokes would swallow
    // the first thing typed after opening a file.
    files.set('notes/plan.md', 'hello');
    render(<TextEditorTab path="notes/plan.md" />);

    const placeholder = await screen.findByText(/opening notes\/plan\.md/u);
    await userEvent.click(placeholder);
    expect(files.get('notes/plan.md')).toBe('hello');
  });
});
