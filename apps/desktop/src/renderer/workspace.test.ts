import { describe, expect, it } from 'vitest';
import {
  EDITOR_TAB,
  type WorkspaceTabKind,
  WORKSPACE_TAB_KINDS,
  activeTab,
  closeTab,
  descriptorFor,
  emptyWorkspace,
  focusTab,
  openTab,
  retitleTab,
} from './workspace.js';

/**
 * What the window is showing, as tabs.
 *
 * Issue #31. The effect editor covered the whole window and the only way back to the timeline was to
 * close it — the wrong shape for anything you work in *alongside* the cut.
 */

describe('the kinds', () => {
  it.each(['editor', 'effect', 'text'] as const)('%s is described', (kind: WorkspaceTabKind) => {
    // The bar draws from the descriptor rather than from a switch, so a kind with no entry would draw
    // as whatever the fallback happens to be — silently, and only for that kind.
    expect(WORKSPACE_TAB_KINDS.some((entry) => entry.kind === kind)).toBe(true);
    expect(descriptorFor(kind).kind).toBe(kind);
  });

  it('makes only the editor unclosable', () => {
    // It is the application. A window with no tabs would need an empty state that is really a fourth
    // layout nobody asked for.
    expect(descriptorFor('editor').closable).toBe(false);
    expect(descriptorFor('effect').closable).toBe(true);
    expect(descriptorFor('text').closable).toBe(true);
  });
});

describe('a new workspace', () => {
  it('is the editor, focused', () => {
    const workspace = emptyWorkspace();
    expect(workspace.tabs).toEqual([EDITOR_TAB]);
    expect(activeTab(workspace)).toEqual(EDITOR_TAB);
  });
});

describe('opening a tab', () => {
  it('adds it and focuses it', () => {
    const workspace = openTab(emptyWorkspace(), { kind: 'effect', subject: 'film_grain' });
    expect(workspace.tabs).toHaveLength(2);
    expect(activeTab(workspace).subject).toBe('film_grain');
  });

  it('focuses the one already showing that subject rather than opening a second', () => {
    // Two tabs editing one effect lets a user make two sets of changes and lose one on save, without
    // being told.
    const once = openTab(emptyWorkspace(), { kind: 'effect', subject: 'film_grain' });
    const twice = openTab(once, { kind: 'effect', subject: 'film_grain' });
    expect(twice.tabs).toHaveLength(2);
    expect(twice.active).toBe(once.active);
  });

  it('treats two subjectless tabs as two things', () => {
    // Two *new* effects are genuinely two effects, and collapsing them throws away work with nowhere
    // else to live.
    const once = openTab(emptyWorkspace(), { kind: 'effect' });
    const twice = openTab(once, { kind: 'effect' });
    expect(twice.tabs).toHaveLength(3);
  });

  it('keeps the same subject in different kinds apart', () => {
    // A file named `film_grain` and an effect called `film_grain` are not the same tab.
    const workspace = openTab(openTab(emptyWorkspace(), { kind: 'effect', subject: 'x' }), {
      kind: 'text',
      subject: 'x',
    });
    expect(workspace.tabs).toHaveLength(3);
  });

  it('titles it by the subject, or by what the kind is called', () => {
    expect(openTab(emptyWorkspace(), { kind: 'effect', subject: 'film_grain' }).tabs[1]?.title).toBe(
      'film_grain',
    );
    expect(openTab(emptyWorkspace(), { kind: 'effect' }).tabs[1]?.title).toBe('New effect');
  });

  it('prefers a title it was given', () => {
    const workspace = openTab(emptyWorkspace(), {
      kind: 'effect',
      subject: 'film_grain',
      title: 'Film grain',
    });
    expect(workspace.tabs[1]?.title).toBe('Film grain');
  });
});

describe('closing one', () => {
  const withTwo = () =>
    openTab(openTab(emptyWorkspace(), { kind: 'effect', subject: 'a' }), {
      kind: 'effect',
      subject: 'b',
    });

  it('removes it', () => {
    const closed = closeTab(withTwo(), 'effect:a');
    expect(closed.tabs.map((tab) => tab.id)).toEqual(['editor', 'effect:b']);
  });

  it('focuses the tab to its left, which is where the eye already is', () => {
    // Landing on the far end of the bar is disorienting in a way that is hard to name and easy to
    // feel.
    const closed = closeTab(withTwo(), 'effect:b');
    expect(closed.active).toBe('effect:a');
  });

  it('leaves the focus alone when the tab closed was not the active one', () => {
    const closed = closeTab(withTwo(), 'effect:a');
    expect(closed.active).toBe('effect:b');
  });

  it('refuses to close the editor', () => {
    // Not loudly: the bar draws no close control for it, so reaching here means a keyboard path or a
    // stale id.
    expect(closeTab(withTwo(), 'editor')).toEqual(withTwo());
  });

  it('ignores an id nothing holds', () => {
    expect(closeTab(withTwo(), 'effect:gone')).toEqual(withTwo());
  });

  it('always leaves something focused', () => {
    // The invariant the whole model rests on: `activeTab` never has to answer `undefined`.
    let workspace = withTwo();
    for (const id of ['effect:b', 'effect:a', 'editor']) workspace = closeTab(workspace, id);
    expect(activeTab(workspace)).toEqual(EDITOR_TAB);
  });
});

describe('focusing one', () => {
  it('moves to it', () => {
    const workspace = openTab(emptyWorkspace(), { kind: 'effect', subject: 'a' });
    expect(focusTab(workspace, 'editor').active).toBe('editor');
  });

  it('leaves the workspace alone for an id nothing holds', () => {
    // Otherwise a stale id blanks the window, which is the one outcome worse than doing nothing.
    const workspace = openTab(emptyWorkspace(), { kind: 'effect', subject: 'a' });
    expect(focusTab(workspace, 'effect:gone')).toEqual(workspace);
  });
});

describe('renaming one', () => {
  it('follows the subject as it is named', () => {
    // A bar of three unsaved effects is unusable otherwise.
    const workspace = retitleTab(openTab(emptyWorkspace(), { kind: 'effect' }), 'effect:new:2', 'Film grain');
    expect(workspace.tabs[1]?.title).toBe('Film grain');
  });

  it('falls back to the kind’s title when the name is cleared', () => {
    const opened = retitleTab(openTab(emptyWorkspace(), { kind: 'effect' }), 'effect:new:2', 'x');
    expect(retitleTab(opened, 'effect:new:2', '   ').tabs[1]?.title).toBe('New effect');
  });

  it('leaves every other tab alone', () => {
    const two = openTab(openTab(emptyWorkspace(), { kind: 'effect', subject: 'a' }), {
      kind: 'effect',
      subject: 'b',
    });
    expect(retitleTab(two, 'effect:a', 'Renamed').tabs[2]?.title).toBe('b');
  });
});
