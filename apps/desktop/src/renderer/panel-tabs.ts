/**
 * The right column's tabs, as data.
 *
 * Issue #29: everything lived in one `inspector` tab — a clip's name, its timing, its framing, the
 * effect stack, the transitions, the audio mix, the project's settings and the application's. Most of
 * it is irrelevant to whatever you opened the panel to do, and a stack that long buries the one
 * control you came for.
 *
 * Written as a list rather than a union spread across a `switch` and a `TabsList`, for the reason the
 * workspace bar is: a new tab should be an entry. The three places that used to need editing — the
 * type, the trigger list and the content list — are now one.
 *
 * ## Sections, not components
 *
 * A tab names the *sections* it shows rather than the components it renders, because the clip
 * inspector is one component covering six unrelated concerns and splitting it into six would scatter
 * the rules that keep them consistent. It takes a set instead and draws what it is asked for.
 */

export type PanelTab = 'clip' | 'effects' | 'markers' | 'generate' | 'variants' | 'segment' | 'project';

/** A section of the clip inspector. Named here because the tabs are what decide where each one goes. */
export type ClipSection =
  'identity' | 'timing' | 'transform' | 'effects' | 'audio' | 'transitions' | 'keyframe';

export interface PanelTabDescriptor {
  readonly id: PanelTab;
  readonly label: string;
  /**
   * Clip-inspector sections this tab shows, in the order they are drawn.
   *
   * Empty for a tab that draws something else entirely — `generate`, `variants`, `segment` and
   * `project` have nothing to do with the selected clip.
   */
  readonly sections: readonly ClipSection[];
}

export const PANEL_TABS: readonly PanelTabDescriptor[] = [
  {
    id: 'clip',
    label: 'Clip',
    // What the clip *is* and where it sits. Timing before framing, because where a clip is comes
    // before how it is framed — the order the inspector already used.
    // The selected marker first. It is the most transient thing in the column — it exists only while
    // one is clicked — and burying it under six standing sections would mean scrolling to reach
    // something you selected a moment ago.
    sections: ['keyframe', 'identity', 'timing', 'transform', 'audio', 'transitions'],
  },
  // Its own tab, which is what #29 asked for by name: the stack, its parameters and its mask binding
  // are a workspace of their own and were competing with six other things for the same column.
  { id: 'effects', label: 'Effects', sections: ['effects'] },
  // Beside the clip rather than under the project, because a marker is a note about *the cut* — the
  // thing being worked on — and not a property of the file it is saved in.
  { id: 'markers', label: 'Markers', sections: [] },
  { id: 'generate', label: 'Generate', sections: [] },
  { id: 'variants', label: 'Variants', sections: [] },
  { id: 'segment', label: 'Segment', sections: [] },
  // Last, because it is the one nobody opens twice a minute: the project's shape and the machine's
  // preferences.
  { id: 'project', label: 'Project', sections: [] },
];

export function panelTab(id: PanelTab): PanelTabDescriptor {
  return (
    PANEL_TABS.find((tab) => tab.id === id) ??
    // Non-null by construction — every member of the union is listed above, and `panel-tabs.test.ts`
    // asserts it. The fallback exists so a stored tab id from another build cannot blank the column.
    (PANEL_TABS[0] as PanelTabDescriptor)
  );
}

/** The sections a tab shows, as a set, which is what the inspector takes. */
export function sectionsFor(id: PanelTab): ReadonlySet<ClipSection> {
  return new Set(panelTab(id).sections);
}

/**
 * Whether a tab is about the selected clip.
 *
 * Used to decide what to say when nothing is selected: "no clip selected" is the right emptiness for
 * the clip and effects tabs and a lie on the project tab, which does not care.
 */
export function isClipTab(id: PanelTab): boolean {
  return panelTab(id).sections.length > 0;
}
