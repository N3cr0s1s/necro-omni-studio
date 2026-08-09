// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DesktopBridge } from '../main/ipc-contract.js';
import { TextEditorTab } from './TextEditorTab.js';

/**
 * The file editor's completion, per issue #31.
 *
 * Driven through the real textarea rather than through the completion engine, which is tested on its
 * own. What is worth asserting *here* is the wiring the engine cannot see: that the chord opens a
 * list, that the caret the suggestions are computed from is the live one, and that accepting one puts
 * the text into the field the user is actually looking at.
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

  // jsdom lays nothing out, so the popup's measuring pass reads zeroes. It positions; it does not
  // decide what is offered, which is what these check.
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
});

afterEach(() => {
  cleanup();
  delete (globalThis as { nos?: unknown }).nos;
  vi.restoreAllMocks();
});

async function open(path: string, contents: string) {
  files.set(path, contents);
  render(<TextEditorTab path={path} />);
  const area = await screen.findByLabelText('File contents');
  await waitFor(() => expect((area as HTMLTextAreaElement).value).toBe(contents));
  return area as HTMLTextAreaElement;
}

/** Puts the caret where the marker is and asks for suggestions. */
async function ask(area: HTMLTextAreaElement, offset: number) {
  area.setSelectionRange(offset, offset);
  area.focus();
  await userEvent.keyboard('{Control>} {/Control}');
}

describe('asking for suggestions in a generator manifest', () => {
  it('offers the manifest’s own fields', async () => {
    const area = await open('generators/a.manifest.json', '{\n  "\n}');
    await ask(area, 5);

    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).not.toBeNull();
    expect(screen.queryByText('default_variants')).not.toBeNull();
  });

  it('offers the file’s spelling, not the model’s', async () => {
    // The on-disk format is snake_case and the loader translates. Suggesting `defaultVariants` writes
    // a field that is dropped without a word.
    const area = await open('generators/a.manifest.json', '{\n  "\n}');
    await ask(area, 5);

    expect(screen.queryByText('defaultVariants')).toBeNull();
  });

  it('says what a field is for, which is most of the value', async () => {
    const area = await open('generators/a.manifest.json', '{\n  "\n}');
    await ask(area, 5);

    expect(screen.queryByText(/How many takes a run asks for/i)).not.toBeNull();
  });
});

describe('asking in a file nothing describes', () => {
  it('offers nothing rather than something plausible', async () => {
    const area = await open('notes/plan.json', '{\n  "\n}');
    await ask(area, 5);

    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull();
  });
});

describe('accepting one', () => {
  it('writes it into the file being edited', async () => {
    const area = await open('effects/tint.json', '{\n  "sha\n}');
    await ask(area, 8);

    await userEvent.keyboard('{Enter}');
    // The quote it was inside is closed and the colon comes with it, because typing an opening quote
    // is exactly how you get here.
    expect(area.value).toContain('"shader": ');
  });

  it('does not double the quotes it is already inside', async () => {
    const area = await open('effects/tint.json', '{\n  "sha"\n}');
    await ask(area, 8);
    await userEvent.keyboard('{Enter}');

    expect(area.value).toContain('"shader"');
    expect(area.value).not.toContain('""');
  });

  it('closes the list', async () => {
    const area = await open('effects/tint.json', '{\n  "sha\n}');
    await ask(area, 8);
    await userEvent.keyboard('{Enter}');

    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull();
  });
});

describe('dismissing the list', () => {
  it('closes on Escape without changing the text', async () => {
    const area = await open('effects/tint.json', '{\n  "sha\n}');
    await ask(area, 8);
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull();
    expect(area.value).toBe('{\n  "sha\n}');
  });
});

describe('the field it sits over', () => {
  it('stays a plain textarea, so typing is never intercepted', async () => {
    // The whole technique depends on the platform's own text editing: selection, undo and IME are the
    // browser's rather than reimplemented.
    const area = await open('notes/plan.json', '');
    await userEvent.type(area, 'hello');
    expect(area.value).toBe('hello');
  });
});
