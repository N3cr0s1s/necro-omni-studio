/**
 * What the window is showing, as tabs.
 *
 * Issue #31. The effect editor covered the whole window and the only way back to the timeline was to
 * close it — which is the wrong shape for anything you work in *alongside* the cut. A shader is
 * written while looking at the clip it is for; a manifest is edited while the generator panel is open.
 *
 * ## Kinds are data
 *
 * A tab's kind decides its title, its icon and what it renders, and adding one is an entry in
 * `WORKSPACE_TAB_KINDS` plus a case where tabs are drawn. The bar itself never learns about a new
 * kind — it reads the descriptor. That is what "framework szinten" asks for: the next editor someone
 * wants is a kind, not a rewrite.
 *
 * ## Why the editor tab cannot be closed
 *
 * It is the application. A window with no tabs would need an empty state that is really a fourth
 * layout nobody asked for, and "close the last tab" is a gesture with no good answer. It is pinned
 * instead, which is also why it is always first.
 */

export type WorkspaceTabKind = 'editor' | 'effect' | 'text';

/** What a kind is, so the bar can draw a tab without knowing what is inside it. */
export interface WorkspaceTabDescriptor {
  readonly kind: WorkspaceTabKind;
  /** Shown when the tab carries no subject of its own — a new effect has no name yet. */
  readonly fallbackTitle: string;
  /** Whether a tab of this kind can be closed. Only the editor cannot. */
  readonly closable: boolean;
}

export const WORKSPACE_TAB_KINDS: readonly WorkspaceTabDescriptor[] = [
  { kind: 'editor', fallbackTitle: 'Editor', closable: false },
  { kind: 'effect', fallbackTitle: 'New effect', closable: true },
  { kind: 'text', fallbackTitle: 'File', closable: true },
];

export function descriptorFor(kind: WorkspaceTabKind): WorkspaceTabDescriptor {
  return (
    WORKSPACE_TAB_KINDS.find((entry) => entry.kind === kind) ??
    // Non-null by construction: every member of the union is listed above, and `workspace.test.ts`
    // asserts it. The fallback exists so a kind read from stored state cannot crash the window.
    (WORKSPACE_TAB_KINDS[0] as WorkspaceTabDescriptor)
  );
}

export interface WorkspaceTab {
  /**
   * Identity, and the reason opening the same thing twice focuses rather than duplicates.
   *
   * Derived from the kind and the subject — `effect:film_grain` — so two requests to edit one effect
   * are the same tab. A tab with no subject gets a fresh id, because two *new* effects are genuinely
   * two things.
   */
  readonly id: string;
  readonly kind: WorkspaceTabKind;
  /** What the tab is about: an effect id, a file path. Absent for a tab that is about nothing yet. */
  readonly subject?: string;
  /** Shown on the tab. Falls back to the kind's own title. */
  readonly title: string;
}

export interface Workspace {
  readonly tabs: readonly WorkspaceTab[];
  readonly active: string;
}

/** The editor tab, which is always present and always first. */
export const EDITOR_TAB: WorkspaceTab = { id: 'editor', kind: 'editor', title: 'Editor' };

export function emptyWorkspace(): Workspace {
  return { tabs: [EDITOR_TAB], active: EDITOR_TAB.id };
}

/**
 * Opens a tab, or focuses the one already showing that subject.
 *
 * Focusing rather than duplicating is the whole reason tabs carry a subject: two tabs editing one
 * effect would let a user make two sets of changes and lose one of them on save, silently.
 *
 * A tab with no subject is always new. Two unnamed effects are two effects, and collapsing them would
 * throw away work that has nowhere else to live.
 */
export function openTab(
  workspace: Workspace,
  request: { readonly kind: WorkspaceTabKind; readonly subject?: string; readonly title?: string },
): Workspace {
  const descriptor = descriptorFor(request.kind);
  const id =
    request.subject === undefined
      ? `${request.kind}:new:${workspace.tabs.length + 1}`
      : `${request.kind}:${request.subject}`;

  const existing = workspace.tabs.find((tab) => tab.id === id);
  if (existing !== undefined) return { ...workspace, active: id };

  const tab: WorkspaceTab = {
    id,
    kind: request.kind,
    ...(request.subject !== undefined ? { subject: request.subject } : {}),
    title: request.title ?? request.subject ?? descriptor.fallbackTitle,
  };

  return { tabs: [...workspace.tabs, tab], active: id };
}

/**
 * Closes a tab and decides what to look at next.
 *
 * The tab to its **left**, which is where the eye already is and what every editor with tabs does.
 * Closing the active tab and landing on the far end of the bar is disorienting in a way that is hard
 * to name and easy to feel.
 *
 * A tab whose kind cannot be closed is left alone rather than refused loudly: the bar does not draw a
 * close control for it, so reaching here at all means a keyboard path or a stale id.
 */
export function closeTab(workspace: Workspace, id: string): Workspace {
  const index = workspace.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return workspace;
  if (!descriptorFor(workspace.tabs[index]!.kind).closable) return workspace;

  const tabs = workspace.tabs.filter((tab) => tab.id !== id);
  if (workspace.active !== id) return { ...workspace, tabs };

  const neighbour = tabs[Math.max(0, index - 1)] ?? EDITOR_TAB;
  return { tabs, active: neighbour.id };
}

/** Focuses a tab. An id nothing holds leaves the workspace alone rather than blanking the window. */
export function focusTab(workspace: Workspace, id: string): Workspace {
  return workspace.tabs.some((tab) => tab.id === id) ? { ...workspace, active: id } : workspace;
}

/**
 * Renames a tab, for a subject that only gets a name once the user has typed one.
 *
 * A new effect opens as "New effect" and becomes "Film grain" as it is named, which is what makes a
 * bar of three unsaved effects usable at all.
 */
export function retitleTab(workspace: Workspace, id: string, title: string): Workspace {
  const trimmed = title.trim();
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) =>
      tab.id === id
        ? { ...tab, title: trimmed === '' ? descriptorFor(tab.kind).fallbackTitle : trimmed }
        : tab,
    ),
  };
}

/** The tab currently showing, which is never `undefined` — the editor tab cannot be closed. */
export function activeTab(workspace: Workspace): WorkspaceTab {
  return workspace.tabs.find((tab) => tab.id === workspace.active) ?? EDITOR_TAB;
}
