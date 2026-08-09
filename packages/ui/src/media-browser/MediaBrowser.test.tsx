// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetPath } from '@nos/core';
import { type FileEntry, type WatcherStatus, buildTree } from '@nos/media';
import { AssetDetail, MediaBrowser } from './MediaBrowser.js';

afterEach(cleanup);

function file(path: string, sizeBytes = 1000): FileEntry {
  return { path: assetPath(path), sizeBytes, isDirectory: false };
}

function directory(path: string): FileEntry {
  return { path: assetPath(path), sizeBytes: 0, isDirectory: true };
}

/** The folder layout from the mockups. */
function projectTree() {
  return buildTree([
    file('project.json', 4096),
    file('media/interview_a.mp4', 1_000_000),
    file('media/broll_city.mov', 500_000),
    file('media/room_tone.wav', 20_000),
    file('generated/t2v_0117_seed4471.mp4', 2_000_000),
    file('generated/bed_0031_seed881.flac', 300_000),
    file('notes/treatment.md', 2000),
    file('notes/reference.psd', 9000),
    directory('renders'),
    directory('cache'),
    directory('media/archive'),
    file('media/archive/old.mp4', 100),
  ]);
}

const watching: WatcherStatus = { watching: true };

function renderBrowser(overrides: Partial<Parameters<typeof MediaBrowser>[0]> = {}) {
  return render(<MediaBrowser tree={projectTree()} watcher={watching} {...overrides} />);
}

describe('tree rendering', () => {
  it('shows the reserved folders in their conventional order', () => {
    renderBrowser();
    const items = screen.getAllByRole('treeitem');
    const names = items.map((item) => item.textContent ?? '');
    // `media` must precede `generated`, which must precede `notes` — muscle-memory ordering, not
    // alphabetical.
    const mediaIndex = names.findIndex((name) => name.includes('media'));
    const generatedIndex = names.findIndex((name) => name.includes('generated'));
    const notesIndex = names.findIndex((name) => name.includes('notes'));
    expect(mediaIndex).toBeLessThan(generatedIndex);
    expect(generatedIndex).toBeLessThan(notesIndex);
  });

  it('expands the working folders by default and leaves derived ones closed', () => {
    renderBrowser();
    // media/ is open, so its children are visible.
    expect(screen.getByText('interview_a.mp4')).toBeDefined();
    expect(screen.getByText('bed_0031_seed881.flac')).toBeDefined();
    // renders/ and cache/ are closed.
    expect(screen.queryByText('old.mp4')).toBeNull();
  });

  it('shows files the app cannot type, because the user put them there', () => {
    // The spec permits arbitrary files in the project folder.
    renderBrowser();
    expect(screen.getByText('reference.psd')).toBeDefined();
  });

  it('reports the generated folder size, since there is no retention policy', () => {
    renderBrowser();
    const generated = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('generated'));
    expect(generated?.textContent).toContain('2.19 MB');
  });

  it('labels the cache folder as derived so it reads as safe to delete', () => {
    renderBrowser();
    const cache = screen
      .getAllByRole('treeitem')
      .find((item) => item.getAttribute('aria-expanded') === 'false' && item.textContent?.includes('cache'));
    expect(cache?.textContent).toContain('derived');
  });

  it('says there is no project when none is open, rather than that its folder is empty', () => {
    // An empty project and no project both arrive as a directory with no children, so the tree cannot
    // tell them apart. Saying "this project folder is empty" to someone who has opened nothing tells
    // them the folder they do not have is empty.
    render(<MediaBrowser tree={buildTree([])} watcher={watching} projectOpen={false} />);
    expect(screen.getByText(/no project open/i)).toBeDefined();
  });

  it('renders an explanation rather than a blank panel when the project is empty', () => {
    render(<MediaBrowser tree={buildTree([])} watcher={watching} />);
    expect(screen.getByText(/empty/i)).toBeDefined();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });
});

describe('expansion', () => {
  it('opens a closed folder on click', async () => {
    const user = userEvent.setup();
    renderBrowser();

    expect(screen.queryByText('old.mp4')).toBeNull();
    const archive = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('archive'));
    await user.click(archive!);

    expect(screen.getByText('old.mp4')).toBeDefined();
  });

  it('collapses an open folder on click', async () => {
    const user = userEvent.setup();
    renderBrowser();

    const media = screen
      .getAllByRole('treeitem')
      .find((item) => item.getAttribute('aria-expanded') === 'true');
    await user.click(media!);

    expect(screen.queryByText('interview_a.mp4')).toBeNull();
  });

  it('exposes expansion state to assistive technology', () => {
    renderBrowser();
    const items = screen.getAllByRole('treeitem');
    const expandable = items.filter((item) => item.hasAttribute('aria-expanded'));
    expect(expandable.length).toBeGreaterThan(0);
    // Files must not claim to be expandable.
    const fileRow = items.find((item) => item.textContent?.includes('interview_a.mp4'));
    expect(fileRow?.hasAttribute('aria-expanded')).toBe(false);
  });

  it('reports nesting depth, so a screen reader can convey structure', () => {
    renderBrowser();
    const media = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('archive'));
    expect(media?.getAttribute('aria-level')).toBe('2');
  });
});

describe('selection and activation', () => {
  it('selects a file on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderBrowser({ onSelect });

    await user.click(screen.getByText('interview_a.mp4'));

    expect(onSelect).toHaveBeenCalledWith('media/interview_a.mp4');
  });

  it('does not report a directory as a selected asset', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderBrowser({ onSelect });

    const renders = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('renders'));
    await user.click(renders!);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks the selected row for assistive technology', () => {
    renderBrowser({ selected: assetPath('media/interview_a.mp4') });
    const selected = screen
      .getAllByRole('treeitem')
      .filter((item) => item.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain('interview_a.mp4');
  });

  it('activates a file on double click', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderBrowser({ onActivate });

    await user.dblClick(screen.getByText('broll_city.mov'));

    expect(onActivate).toHaveBeenCalledWith('media/broll_city.mov');
  });
});

describe('keyboard operation', () => {
  it('activates the focused file with Enter', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderBrowser({ onActivate });

    const row = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('interview_a.mp4'));
    row!.focus();
    await user.keyboard('{Enter}');

    expect(onActivate).toHaveBeenCalledWith('media/interview_a.mp4');
  });

  it('opens a folder with ArrowRight and closes it with ArrowLeft', async () => {
    const user = userEvent.setup();
    renderBrowser();

    const archive = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('archive'));
    archive!.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('old.mp4')).toBeDefined();

    screen
      .getAllByRole('treeitem')
      .find((item) => item.textContent?.includes('archive'))!
      .focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByText('old.mp4')).toBeNull();
  });

  it('makes every row reachable by keyboard', () => {
    renderBrowser();
    for (const item of screen.getAllByRole('treeitem')) {
      expect(item.getAttribute('tabindex')).toBe('0');
    }
  });
});

describe('dragging onto the timeline', () => {
  it('makes timeline-capable assets draggable', () => {
    renderBrowser();
    const row = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('interview_a.mp4'));
    expect(row?.getAttribute('draggable')).toBe('true');
  });

  it('does not make notes or unknown files draggable', () => {
    // A markdown note is a text asset but not something you drop on a track.
    renderBrowser();
    const note = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('treatment.md'));
    expect(note?.getAttribute('draggable')).toBe('false');
  });

  it('does not make directories draggable', () => {
    renderBrowser();
    const renders = screen.getAllByRole('treeitem').find((item) => item.textContent?.includes('renders'));
    expect(renders?.getAttribute('draggable')).toBe('false');
  });
});

describe('watcher status', () => {
  it('shows that the folder is being watched', () => {
    renderBrowser();
    expect(screen.getByText('watching')).toBeDefined();
    expect(screen.getByRole('img', { name: 'Watching for changes' })).toBeDefined();
  });

  it('distinguishes idle from watching rather than looking the same', () => {
    renderBrowser({ watcher: { watching: false } });
    expect(screen.getByText('idle')).toBeDefined();
  });

  it('surfaces a watcher failure with a way to recover', async () => {
    // A silently dead watcher is worse than none: the user would trust a stale tree.
    const user = userEvent.setup();
    const onRescan = vi.fn();
    renderBrowser({
      watcher: { watching: false, error: { kind: 'limit-exceeded', detail: 'too many files' } },
      onRescan,
    });

    const button = screen.getByRole('button', { name: /rescan/i });
    expect(button.getAttribute('title')).toBe('too many files');
    await user.click(button);
    expect(onRescan).toHaveBeenCalled();
  });
});

/** The classes on the artifact row named `label`, which is where its readiness is expressed. */
function readinessOf(label: string): string {
  return screen.getByText(label).className;
}

describe('AssetDetail', () => {
  it('reports derived artifact readiness', () => {
    render(
      <AssetDetail
        name="broll_city.mov"
        summary="1920×1080 · 29.97"
        hash="9f3c1a27b4e8d016"
        hasProxy
        hasFilmstrip
      />,
    );
    // Ready is an icon beside the word now, not a tick inside it: the two are separate elements, so
    // the readiness is asserted on the row rather than on a run of text.
    expect(readinessOf('proxy')).toContain('text-chart-2');
    expect(readinessOf('filmstrip')).toContain('text-chart-2');
    expect(screen.getByText(/hash 9f3c1a/)).toBeDefined();
  });

  it('shows a pending artifact as work not yet done, not as an error', () => {
    render(<AssetDetail name="a.mp4" hasProxy={false} />);
    expect(readinessOf('proxy')).not.toContain('text-chart-2');
  });

  it('omits an artifact row entirely when readiness is unknown', () => {
    render(<AssetDetail name="a.mp4" />);
    expect(screen.queryByText(/proxy/)).toBeNull();
  });

  it('marks generator output, since purple always means a generator made it', () => {
    render(<AssetDetail name="t2v_0117.mp4" isGenerated />);
    const detail = screen.getByText('t2v_0117.mp4').parentElement;
    expect(within(detail!).getByText('generated')).toBeDefined();
  });
});

/**
 * Narrowing the folder.
 *
 * A generator fills `generated/` with names that differ in the middle — twenty runs in, finding one
 * take means reading forty of them. Scrolling is not a way to find a file.
 */
describe('filtering', () => {
  const shown = (): readonly string[] =>
    [...document.querySelectorAll('[role="treeitem"]')]
      .map((row) => row.textContent ?? '')
      .filter((text) => text.includes('.'));

  it('narrows to what was typed', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.type(screen.getByLabelText('Filter the project folder'), 'seed4471');

    expect(shown().some((name) => name.includes('t2v_0117_seed4471.mp4'))).toBe(true);
    expect(shown().some((name) => name.includes('room_tone.wav'))).toBe(false);
  });

  it('opens the folders a match lives in', async () => {
    // A match three folders down would otherwise sit behind collapsed folders, and the user would
    // conclude the search does not work.
    const user = userEvent.setup();
    renderBrowser();
    await user.type(screen.getByLabelText('Filter the project folder'), 'old.mp4');

    expect(shown().some((name) => name.includes('old.mp4'))).toBe(true);
  });

  it('says how much of the folder is showing', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.type(screen.getByLabelText('Filter the project folder'), 'mp4');

    // interview_a, t2v_0117, archive/old — of nine files in the project.
    expect(screen.getByText('3 of 9')).toBeTruthy();
  });

  it('keeps the count out of the way while nothing is filtered', () => {
    renderBrowser();
    expect(screen.queryByText(/ of 9$/)).toBeNull();
  });

  it('says so when nothing matches, rather than looking empty', async () => {
    // An empty result and an empty project look identical, and only one of them means the user should
    // try a different word.
    const user = userEvent.setup();
    renderBrowser();
    await user.type(screen.getByLabelText('Filter the project folder'), 'no such file');

    expect(screen.getByText('nothing here matches')).toBeTruthy();
  });

  it('restores the folder when the filter is cleared', async () => {
    const user = userEvent.setup();
    renderBrowser();
    const box = screen.getByLabelText('Filter the project folder');
    await user.type(box, 'seed4471');
    await user.click(screen.getByRole('button', { name: 'Clear the filter' }));

    expect(shown().some((name) => name.includes('room_tone.wav'))).toBe(true);
  });

  it('clears on Escape, so a stale filter cannot survive moving away', async () => {
    const user = userEvent.setup();
    renderBrowser();
    const box = screen.getByLabelText('Filter the project folder');
    await user.type(box, 'seed4471');
    await user.keyboard('{Escape}');

    expect((box as HTMLInputElement).value).toBe('');
  });

  it('narrows to one kind of material', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.click(screen.getByRole('button', { name: 'Only audio' }));

    expect(shown().some((name) => name.includes('room_tone.wav'))).toBe(true);
    expect(shown().some((name) => name.includes('interview_a.mp4'))).toBe(false);
  });

  it('offers only kinds a project folder actually holds', () => {
    // A `text` filter would always return nothing, and a control that never works teaches the user
    // that none of them do.
    renderBrowser();
    expect(screen.queryByRole('button', { name: 'Only mask' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Only video' })).toBeTruthy();
  });
});

describe('reaching the filter', () => {
  it('takes the caret on Ctrl+F', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.keyboard('{Control>}f{/Control}');

    expect(document.activeElement).toBe(screen.getByLabelText('Filter the project folder'));
  });

  it('selects what is already there, so a second search replaces the first', async () => {
    const user = userEvent.setup();
    renderBrowser();
    const box = screen.getByLabelText('Filter the project folder') as HTMLInputElement;
    await user.type(box, 'seed4471');
    await user.keyboard('{Control>}f{/Control}');

    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe('seed4471'.length);
  });
});
