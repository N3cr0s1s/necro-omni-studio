import { describe, expect, it } from 'vitest';
import { assetPath } from '@nos/core';
import {
  type FileChange,
  WATCH_DEBOUNCE_MS,
  coalesceChanges,
  isCacheContent,
  isIgnoredPath,
  normalizeChanges,
} from './watcher.js';

function change(
  kind: FileChange['kind'],
  path: string,
  overrides: Partial<FileChange> = {},
): FileChange {
  return { kind, path: assetPath(path), isDirectory: false, ...overrides };
}

describe('isIgnoredPath', () => {
  it('hides OS and editor droppings', () => {
    for (const path of ['media/.DS_Store', 'Thumbs.db', 'media/desktop.ini', 'media/.gitkeep']) {
      expect(isIgnoredPath(path)).toBe(true);
    }
  });

  it('hides partial writes, so an incomplete asset is never draggable', () => {
    // A watcher fires while a large generator output is still being written.
    for (const path of [
      'generated/t2v.mp4.part',
      'generated/bed.flac.tmp',
      'media/a.crdownload',
      'notes/.treatment.md.swp',
    ]) {
      expect(isIgnoredPath(path)).toBe(true);
    }
  });

  it('hides lock files from office-style writers', () => {
    expect(isIgnoredPath('notes/~$draft.docx')).toBe(true);
    expect(isIgnoredPath('notes/.#treatment.md')).toBe(true);
  });

  it('shows real assets and project files', () => {
    for (const path of ['project.json', 'media/interview_a.mp4', 'notes/treatment.md']) {
      expect(isIgnoredPath(path)).toBe(false);
    }
  });
});

describe('isCacheContent', () => {
  it('hides files inside the cache', () => {
    expect(isCacheContent('cache/proxy_1080p30q23_abc.mp4')).toBe(true);
  });

  it('does not hide the cache directory itself, which the browser must show with its size', () => {
    expect(isCacheContent('cache')).toBe(false);
  });

  it('does not hide a similarly named user folder', () => {
    expect(isCacheContent('cached_ideas/a.md')).toBe(false);
  });
});

describe('coalesceChanges', () => {
  it('keeps the last event for a path', () => {
    const result = coalesceChanges([
      change('changed', 'media/a.mp4', { sizeBytes: 1 }),
      change('changed', 'media/a.mp4', { sizeBytes: 2 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.sizeBytes).toBe(2);
  });

  it('collapses add-then-change to add, since the tree has not seen the file yet', () => {
    // Writing a file emits create, then one or more writes. Reporting the trailing change
    // against a node the UI does not have would simply be dropped.
    const result = coalesceChanges([
      change('added', 'generated/a.mp4', { sizeBytes: 0 }),
      change('changed', 'generated/a.mp4', { sizeBytes: 900 }),
    ]);
    expect(result).toEqual([
      { kind: 'added', path: 'generated/a.mp4', isDirectory: false, sizeBytes: 900 },
    ]);
  });

  it('cancels add-then-remove entirely, so a transient file never reaches the UI', () => {
    const result = coalesceChanges([
      change('added', 'generated/tmp.mp4'),
      change('removed', 'generated/tmp.mp4'),
    ]);
    expect(result).toEqual([]);
  });

  it('keeps remove-then-add as an add, since the content is new', () => {
    const result = coalesceChanges([
      change('removed', 'media/a.mp4'),
      change('added', 'media/a.mp4', { sizeBytes: 10 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('added');
  });

  it('keeps change-then-remove as a remove', () => {
    const result = coalesceChanges([
      change('changed', 'media/a.mp4'),
      change('removed', 'media/a.mp4'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('removed');
  });

  it('handles independent paths without interference', () => {
    const result = coalesceChanges([
      change('added', 'media/a.mp4'),
      change('added', 'media/b.mp4'),
      change('removed', 'media/a.mp4'),
    ]);
    expect(result.map((entry) => entry.path)).toEqual(['media/b.mp4']);
  });

  it('preserves input order for surviving paths, so the UI applies them predictably', () => {
    const result = coalesceChanges([
      change('added', 'media/c.mp4'),
      change('added', 'media/a.mp4'),
      change('added', 'media/b.mp4'),
    ]);
    expect(result.map((entry) => entry.path)).toEqual([
      'media/c.mp4',
      'media/a.mp4',
      'media/b.mp4',
    ]);
  });

  it('is a no-op for an empty batch', () => {
    expect(coalesceChanges([])).toEqual([]);
  });
});

describe('normalizeChanges', () => {
  it('drops ignored and cache paths before coalescing', () => {
    const result = normalizeChanges([
      change('added', 'media/.DS_Store'),
      change('added', 'cache/proxy_x.mp4'),
      change('added', 'media/a.mp4'),
    ]);
    expect(result.map((entry) => entry.path)).toEqual(['media/a.mp4']);
  });

  it('still reports the cache directory itself', () => {
    const result = normalizeChanges([change('added', 'cache', { isDirectory: true })]);
    expect(result).toHaveLength(1);
  });
});

describe('debounce window', () => {
  it('is short enough to feel immediate but long enough to absorb a file write', () => {
    expect(WATCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(50);
    expect(WATCH_DEBOUNCE_MS).toBeLessThanOrEqual(250);
  });
});
