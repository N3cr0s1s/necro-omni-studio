import { describe, expect, it } from 'vitest';
import {
  type ClipSection,
  type PanelTab,
  PANEL_TABS,
  isClipTab,
  panelTab,
  sectionsFor,
} from './panel-tabs.js';

/**
 * The right column's tabs.
 *
 * Issue #29: everything lived in one `inspector` tab, and most of it was irrelevant to whatever the
 * panel had been opened to do.
 */

const EVERY_SECTION: readonly ClipSection[] = [
  'identity',
  'timing',
  'transform',
  'effects',
  'audio',
  'transitions',
];

describe('the tabs', () => {
  it.each(['clip', 'effects', 'generate', 'variants', 'segment', 'project'] as const)(
    '%s is described',
    (id: PanelTab) => {
      // The column draws from this list, so a tab with no entry would silently render the fallback.
      expect(PANEL_TABS.some((tab) => tab.id === id)).toBe(true);
      expect(panelTab(id).id).toBe(id);
    },
  );

  it('gives every one a label', () => {
    for (const tab of PANEL_TABS) expect(tab.label.trim().length).toBeGreaterThan(0);
  });

  it('has no two claiming one id', () => {
    expect(new Set(PANEL_TABS.map((tab) => tab.id)).size).toBe(PANEL_TABS.length);
  });
});

describe('where each part of the clip inspector goes', () => {
  it('shows every section somewhere', () => {
    // The check that makes the split safe: a section left out of every tab is a control that silently
    // disappeared from the application.
    const shown = new Set(PANEL_TABS.flatMap((tab) => tab.sections));
    expect([...EVERY_SECTION].filter((section) => !shown.has(section))).toEqual([]);
  });

  it('shows none of them twice', () => {
    // Two tabs drawing the effect stack would be two stacks editing one clip, and the second would
    // look stale the moment the first was used.
    const all = PANEL_TABS.flatMap((tab) => tab.sections);
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives the effect stack its own tab, which is what #29 asked for', () => {
    expect(panelTab('effects').sections).toEqual(['effects']);
  });

  it('keeps timing before framing, the order the inspector already used', () => {
    const clip = panelTab('clip').sections;
    expect(clip.indexOf('timing')).toBeLessThan(clip.indexOf('transform'));
  });

  it('answers with a set, which is what the inspector takes', () => {
    expect(sectionsFor('effects').has('effects')).toBe(true);
    expect(sectionsFor('effects').has('timing')).toBe(false);
  });
});

describe('which tabs are about the selected clip', () => {
  it('is the clip and effects tabs', () => {
    // "no clip selected" is the right emptiness for these and a lie on the project tab.
    expect(isClipTab('clip')).toBe(true);
    expect(isClipTab('effects')).toBe(true);
  });

  it('is not the ones that are about something else', () => {
    for (const id of ['generate', 'variants', 'segment', 'project'] as const) {
      expect(isClipTab(id)).toBe(false);
    }
  });
});

describe('an id from another build', () => {
  it('falls back rather than blanking the column', () => {
    expect(panelTab('a-tab-from-next-year' as PanelTab).id).toBe('clip');
  });
});
