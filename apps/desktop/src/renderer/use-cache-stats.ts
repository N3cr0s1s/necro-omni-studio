import { useCallback, useEffect, useState } from 'react';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * The size of the derived cache, and the way to empty it.
 *
 * The spec asks the browser to show `cache/` **with its size, so the user can judge whether to clear
 * it** — a judgement they could not make and an action they could not take, though the sidecar has
 * had `/cache/stats` and `/cache/clear` since M2. Proxies made it urgent: a single 4K source now
 * leaves a hundred-megabyte transcode behind, and nothing in the application ever said so.
 *
 * Clearing is safe by construction rather than by care: everything under `cache/` is regenerable,
 * which is exactly why the spec marks that folder disposable and `generated/` not.
 */

export interface CacheStats {
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly clearing: boolean;
  readonly error: string | undefined;
  /** Empties the cache and reports what is left, which should be nothing. */
  clear(): Promise<void>;
  refresh(): void;
}

export interface CacheStatsOptions {
  readonly sidecar: SidecarInfo | undefined;
  /** Bumped by the caller when something is derived, so the size does not go stale on screen. */
  readonly revision?: number;
}

export function useCacheStats(options: CacheStatsOptions): CacheStats {
  const { sidecar, revision = 0 } = options;
  const [stats, setStats] = useState({ sizeBytes: 0, fileCount: 0 });
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (sidecar === undefined || !sidecar.available) {
      setStats({ sizeBytes: 0, fileCount: 0 });
      return;
    }
    let cancelled = false;

    void request(sidecar, '/cache/stats', 'GET').then((body) => {
      if (cancelled || body === undefined) return;
      setStats({ sizeBytes: body.size_bytes, fileCount: body.file_count });
    });

    return () => {
      cancelled = true;
    };
  }, [sidecar, revision, tick]);

  const clear = useCallback(async () => {
    if (sidecar === undefined || !sidecar.available) return;
    setClearing(true);
    setError(undefined);
    try {
      const body = await request(sidecar, '/cache/clear', 'POST');
      if (body === undefined) {
        setError('the cache could not be cleared');
        return;
      }
      // The response reports what is left rather than what was removed, so the number on screen is
      // measured rather than assumed — a file the sidecar could not delete stays counted.
      setStats({ sizeBytes: body.size_bytes, fileCount: body.file_count });
    } finally {
      setClearing(false);
    }
  }, [sidecar]);

  return { ...stats, clearing, error, clear, refresh };
}

interface StatsBody {
  readonly size_bytes: number;
  readonly file_count: number;
}

async function request(
  sidecar: SidecarInfo,
  path: string,
  method: 'GET' | 'POST',
): Promise<StatsBody | undefined> {
  try {
    const response = await fetch(`${sidecar.baseUrl}${path}`, {
      method,
      headers: { 'x-nos-token': sidecar.token },
    });
    if (!response.ok) return undefined;
    return (await response.json()) as StatsBody;
  } catch {
    return undefined;
  }
}

/**
 * `218 MB` — the unit a user judges disk space in.
 *
 * Decimal megabytes rather than binary, matching what every file manager and every drive label
 * reports. Being consistent with the rest of the machine matters more here than being consistent
 * with memory sizes.
 */
export function formatCacheSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
