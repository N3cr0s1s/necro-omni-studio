import { describe, expect, it } from 'vitest';
import type { ActionMenuItem } from '@nos/ui';
import {
  type BrowserMenuState,
  browserMenuItems,
  isReservedFolder,
  movedPath,
  renamedPath,
  sanitizeFolderName,
} from './browser-menu.js';

function state(overrides: Partial<BrowserMenuState> = {}): BrowserMenuState {
  return { path: 'media/take.mp4', isDirectory: false, ...overrides };
}

const item = (items: readonly ActionMenuItem[], id: string) => items.find((entry) => entry.id === id);

describe('what the browser offers', () => {
  it('can always make a folder, including on empty space', () => {
    // Which is exactly when there is nothing to right-click on: making the first folder.
    expect(item(browserMenuItems(state({ path: undefined })), 'new-folder')?.disabled).toBeFalsy();
  });

  it('says which folder a new one would go in', () => {
    const items = browserMenuItems(state({ path: 'media/shoot-2', isDirectory: true }));
    expect(item(items, 'new-folder')?.label).toBe('New folder in shoot-2');
  });

  it('offers rename and delete for an ordinary file', () => {
    const items = browserMenuItems(state());
    expect(item(items, 'rename')?.disabled).toBe(false);
    expect(item(items, 'delete')?.disabled).toBe(false);
  });

  it('offers nothing to act on when the click was on empty space', () => {
    const items = browserMenuItems(state({ path: undefined }));
    for (const id of ['rename', 'reveal', 'delete']) expect(item(items, id)?.disabled).toBe(true);
  });

  it('protects the reserved folders, and says why', () => {
    // Renaming `media/` leaves every clip pointing into a folder that no longer exists, recoverable
    // only by hand. Protected here rather than behind a confirmation, because a dialog is a question
    // with a wrong answer available.
    for (const folder of ['media', 'generated', 'cache', 'masks', 'renders']) {
      const items = browserMenuItems(state({ path: folder, isDirectory: true }));
      expect(item(items, 'delete')?.disabled).toBe(true);
      expect(item(items, 'rename')?.label).toContain('the project needs this one');
    }
  });

  it('protects the project document', () => {
    const items = browserMenuItems(state({ path: 'project.json' }));
    expect(item(items, 'delete')?.disabled).toBe(true);
  });

  it('does not protect a user folder that merely sits inside a reserved one', () => {
    expect(isReservedFolder('media/shoot-2')).toBe(false);
    expect(
      item(browserMenuItems(state({ path: 'media/shoot-2', isDirectory: true })), 'delete')?.disabled,
    ).toBe(false);
  });

  it('marks deletion as destructive and calls it what it is', () => {
    const remove = item(browserMenuItems(state()), 'delete');
    expect(remove?.danger).toBe(true);
    // The trash, not oblivion: a file the user spent an afternoon generating deserves an undo that
    // the operating system already provides.
    expect(remove?.label).toContain('trash');
  });
});

describe('renaming', () => {
  it('keeps the entry in its folder', () => {
    expect(renamedPath('media/take.mp4', 'hero.mp4')).toBe('media/hero.mp4');
  });

  it('works at the project root', () => {
    expect(renamedPath('notes.md', 'todo.md')).toBe('todo.md');
  });

  it('is nothing when the name did not change', () => {
    expect(renamedPath('media/take.mp4', 'take.mp4')).toBeUndefined();
    expect(renamedPath('media/take.mp4', '  ')).toBeUndefined();
  });

  it('refuses a name that would move the file', () => {
    // Typing a path into a rename field would put the file somewhere the user cannot see from where
    // they are standing. Moving is dragging, where the destination is visible the whole time.
    expect(renamedPath('media/take.mp4', '../take.mp4')).toBeUndefined();
    expect(renamedPath('media/take.mp4', 'sub/take.mp4')).toBeUndefined();
    expect(renamedPath('media/take.mp4', 'sub\\take.mp4')).toBeUndefined();
  });

  it('refuses a name that would hide the file', () => {
    // The browser hides nothing else, so a file that vanished would read as one that was deleted.
    expect(renamedPath('media/take.mp4', '.hidden')).toBeUndefined();
  });
});

describe('moving', () => {
  it('puts the entry in the folder it was dropped on', () => {
    expect(movedPath('media/take.mp4', 'media/shoot-2')).toBe('media/shoot-2/take.mp4');
  });

  it('moves to the project root', () => {
    expect(movedPath('media/take.mp4', '')).toBe('take.mp4');
  });

  it('is nothing when the entry is already there', () => {
    expect(movedPath('media/take.mp4', 'media')).toBeUndefined();
  });

  it('refuses to drop a folder into itself', () => {
    expect(movedPath('media/shoot-2', 'media/shoot-2')).toBeUndefined();
  });

  it('refuses to drop a folder into its own descendant', () => {
    // On most filesystems this either fails obscurely or succeeds and orphans everything below.
    expect(movedPath('media/shoot-2', 'media/shoot-2/day-1')).toBeUndefined();
  });
});

describe('naming a new folder', () => {
  it('takes what was typed', () => {
    expect(sanitizeFolderName('  shoot 2  ')).toBe('shoot 2');
  });

  it('repairs a name rather than refusing it', () => {
    // A name with a slash is a reasonable thing to type and an unreasonable thing to create, and
    // silently making one folder called `a/b` is worse than either.
    expect(sanitizeFolderName('a/b')).toBe('a-b');
    expect(sanitizeFolderName('what? "now"')).toBe('what- -now-');
  });

  it('refuses a name that is nothing at all', () => {
    expect(sanitizeFolderName('   ')).toBeUndefined();
    expect(sanitizeFolderName('...')).toBeUndefined();
  });
});

/*
 * Emptying the derived cache, per §4.
 *
 * `cache/` is the only folder the spec calls derived and deletable, and the sidecar has been able to
 * report and empty it since the media service was written with nothing in the application asking. The
 * row is shaped like `prune-takes` beside it: one folder, disabled elsewhere rather than hidden, and
 * priced before it does anything.
 */
describe('clearing the derived cache', () => {
  const on = (path: string | undefined, cache?: string) =>
    browserMenuItems({ path, isDirectory: true, ...(cache === undefined ? {} : { cache }) }).find(
      (entry) => entry.id === 'clear-cache',
    );

  it('is offered on the cache folder', () => {
    expect(on('cache', '2.41 GB in 40 files')?.disabled).toBe(false);
  });

  it('says what it would reclaim, so the size is not a guess', () => {
    expect(on('cache', '2.41 GB in 40 files')?.label).toContain('2.41 GB in 40 files');
  });

  it('is refused on any other folder', () => {
    expect(on('media', '2.41 GB in 40 files')?.disabled).toBe(true);
    expect(on(undefined, '2.41 GB in 40 files')?.disabled).toBe(true);
  });

  it('is refused when there is nothing to reclaim', () => {
    // An action that would remove nothing should say so by being unavailable, rather than by doing
    // nothing when pressed.
    expect(on('cache')?.disabled).toBe(true);
  });

  it('is not marked destructive, because nothing in the cut is in it', () => {
    expect(on('cache', '1 MB in 2 files')?.danger).toBeUndefined();
  });
});
