import { useCallback, useState } from 'react';

/**
 * Where the panel boundaries were left.
 *
 * A layout is the one setting a user adjusts every session and never thinks about again: a collapsed
 * browser that reopens on every launch is worse than one that never collapsed, because it has to be
 * closed again each time.
 *
 * ## Why this exists rather than a prop
 *
 * `react-resizable-panels` had an `autoSaveId` that did exactly this. Version 4 dropped it in favour
 * of `defaultLayout` and `onLayoutChange`, which is a better contract — the library no longer decides
 * *where* a layout is kept — but it means the storage is the caller's now, and every group would
 * otherwise grow its own copy of read-parse-guard-write.
 *
 * `localStorage` and not the shell. Unlike the last-opened project, losing a layout costs a drag: it
 * is not worth an IPC round trip on every pointer move, and the browser storage that Chromium does not
 * guarantee to persist across a `file://` restart is exactly the right durability for it.
 */

/** Panel id to its share of the group, which is the shape the library reads and writes. */
export type PanelLayout = Readonly<Record<string, number>>;

export interface StoredLayout {
  readonly layout: PanelLayout | undefined;
  readonly onLayoutChange: (layout: PanelLayout) => void;
}

export function useStoredLayout(key: string): StoredLayout {
  // Read once, on mount. A layout that re-read storage would fight the drag in progress, and nothing
  // else in the application writes these keys.
  const [layout] = useState<PanelLayout | undefined>(() => readLayout(key));

  const onLayoutChange = useCallback(
    (next: PanelLayout) => {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(next));
      } catch {
        // A full or unavailable store is not a reason to stop resizing. The panels still move; they
        // simply start where they started last time this succeeded.
      }
    },
    [key],
  );

  return { layout, onLayoutChange };
}

/**
 * A stored layout, or nothing if it cannot be trusted.
 *
 * Validated rather than cast. A layout is a map of panel ids to numbers, and a stale entry naming a
 * panel that no longer exists — or a share that is `NaN` because something wrote a string — makes the
 * group throw or collapse everything to zero. Both are worse than opening at the defaults, so
 * anything unrecognisable is discarded whole.
 */
export function readLayout(key: string): PanelLayout | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined || raw === '') return undefined;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return undefined;
    if (!entries.every(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      return undefined;
    }

    return Object.fromEntries(entries) as PanelLayout;
  } catch {
    return undefined;
  }
}
