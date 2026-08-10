import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from '@nos/media';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * The derived cache, and the one control that empties it.
 *
 * §4 lists `cache/` — proxies, filmstrips, waveform peaks — as *derived and deletable*, which is the
 * only folder in the project the spec says that about. The sidecar has served `/cache/stats` and
 * `/cache/clear` since the media service was written, both covered by its own tests, and **nothing in
 * the application called either**: a user whose cache had grown to a few gigabytes could see the
 * folder in the browser and had no way to reclaim it short of closing the editor and deleting the
 * directory by hand — with the shell still holding proxies open.
 *
 * Deliberately not automatic. A cache that emptied itself on a size threshold would re-derive every
 * proxy in the project at the least convenient moment, which is exactly when a user is working with
 * large sources. It is offered, priced, and left to the person.
 *
 * The transport is separated from the description for the reason `preview-fit` and `passBudgetNote`
 * are: what the row *says* is the part worth pinning down, and it must not need a running sidecar to
 * be checked.
 */

export interface CacheStats {
  readonly bytes: number;
  readonly files: number;
}

export interface DerivedCache {
  /** Absent until the first read lands, or when there is no sidecar to ask. */
  readonly stats: CacheStats | undefined;
  /** Re-reads the size, for after something has been derived. */
  refresh(): void;
  /** Empties it and re-reads. Resolves when the new size is known. */
  clear(): Promise<void>;
}

/**
 * What the menu row says it would reclaim, or nothing when there is nothing to reclaim.
 *
 * `undefined` for an empty cache rather than "0 B", so the caller can disable the row instead of
 * offering to remove nothing — the same rule the gap and crossfade rows follow. Naming both the size
 * and the count because they answer different questions: a hundred megabytes in four files is one
 * long proxy, and the same in four thousand is a filmstrip of a long edit.
 */
export function describeCacheStats(stats: CacheStats | undefined): string | undefined {
  if (stats === undefined || stats.files === 0) return undefined;
  return `${formatBytes(stats.bytes)} in ${stats.files} file${stats.files === 1 ? '' : 's'}`;
}

/** Reads the size of the derived cache. Zero on any failure: a size readout must not throw. */
export async function readCacheStats(sidecar: SidecarInfo): Promise<CacheStats> {
  const response = await fetch(`${sidecar.baseUrl}/cache/stats`, {
    headers: { 'x-nos-token': sidecar.token },
  });
  if (!response.ok) return { bytes: 0, files: 0 };
  return toStats(await response.json());
}

/**
 * Empties the derived cache, and answers with what is left.
 *
 * The sidecar returns the *new* stats from the same call, so the readout after clearing is the
 * server's own number rather than an assumption that the clear worked.
 */
export async function clearDerivedCache(sidecar: SidecarInfo): Promise<CacheStats> {
  const response = await fetch(`${sidecar.baseUrl}/cache/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
    body: JSON.stringify({}),
  });
  if (!response.ok) return { bytes: 0, files: 0 };
  return toStats(await response.json());
}

function toStats(body: unknown): CacheStats {
  const wire = body as { readonly size_bytes?: number; readonly file_count?: number };
  return { bytes: wire.size_bytes ?? 0, files: wire.file_count ?? 0 };
}

/**
 * The cache's size, kept current enough to label a menu row.
 *
 * Read when the sidecar becomes available and after a clear, and not on a timer: this number exists
 * to price one action, and polling a size nobody is looking at would wake the sidecar every few
 * seconds for the life of the session.
 */
export function useDerivedCache(sidecar: SidecarInfo | undefined): DerivedCache {
  const [stats, setStats] = useState<CacheStats | undefined>(undefined);
  const available = sidecar !== undefined && sidecar.available;

  const refresh = useCallback(() => {
    if (sidecar === undefined || !sidecar.available) {
      setStats(undefined);
      return;
    }
    void readCacheStats(sidecar)
      .then(setStats)
      // A failed read leaves the last known number rather than blanking the row: the size is a
      // label, and a sidecar that blinked is not a reason to withdraw an action that still works.
      .catch(() => undefined);
  }, [sidecar]);

  useEffect(refresh, [refresh, available]);

  const clear = useCallback(async () => {
    if (sidecar === undefined || !sidecar.available) return;
    setStats(await clearDerivedCache(sidecar).catch(() => undefined));
  }, [sidecar]);

  return { stats, refresh, clear };
}
