import { useEffect, useRef, useState } from 'react';
import { type DirectoryNode, allFiles } from '@nos/media';
import type { SidecarInfo } from '../main/ipc-contract.js';
import { formatDuration } from './use-asset-detail.js';

/**
 * How long each piece of media is, for the rows in the browser.
 *
 * The one fact an editor wants while scanning a folder of takes, and the browser showed a name and
 * nothing else. Deciding which of four interviews to cut from meant opening each one in turn — the
 * detail panel has known the duration all along, one file at a time.
 *
 * ## Why this is a hook and not a field on the tree
 *
 * The tree comes from the main process, which walks directory entries: a name, a size, a kind. A
 * duration is not on disk — it is in the container, and reading it means asking the sidecar to probe
 * the file. Putting it in the walk would make opening a project wait for a probe of every asset in it.
 *
 * So durations arrive **after** the tree and independently of it, and a row simply has none until its
 * probe lands. That is also why this returns a map rather than a decorated tree: the tree is rebuilt
 * on every watcher event, and a decorated copy would have to be rebuilt with it.
 */

/** Formatted durations by project-relative path. Absent means not probed yet, or not media. */
export type MediaDurations = ReadonlyMap<string, string>;

/**
 * At most this many probes in flight.
 *
 * The sidecar runs one ffprobe per request and a project can hold hundreds of files. Unbounded, a
 * freshly opened folder would fire every probe at once and the sidecar would spend the first seconds
 * of the session unable to answer the thing the user is actually waiting for — the preview's first
 * frame.
 */
const MAX_IN_FLIGHT = 3;

/** Only these are asked about. A markdown note has no duration and a probe of one is a wasted call. */
const TIMED_ASSETS = new Set(['video', 'audio']);

export function useMediaDurations(
  tree: DirectoryNode | undefined,
  sidecar: SidecarInfo | undefined,
): MediaDurations {
  const [durations, setDurations] = useState<MediaDurations>(() => new Map());

  /*
   * Every path ever asked about, kept across tree rebuilds.
   *
   * The watcher rebuilds the tree on any change anywhere — an autosave, a new mask — and without this
   * each rebuild would re-probe every file in the project. A ref rather than state because reading it
   * must not schedule a render.
   */
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (tree === undefined || sidecar === undefined || !sidecar.available) return;

    const wanted = allFiles(tree)
      .filter((file) => TIMED_ASSETS.has(String(file.assetType)))
      .map((file) => file.path)
      .filter((path) => !asked.current.has(path));
    if (wanted.length === 0) return;

    for (const path of wanted) asked.current.add(path);

    let live = true;
    const queue = [...wanted];

    /*
     * One worker per slot, each taking the next path when it finishes.
     *
     * Rather than slicing the list into fixed batches: a batch waits for its slowest member before
     * starting the next, so one long file stalls two idle slots. This keeps all three busy until the
     * queue is empty.
     */
    const worker = async (): Promise<void> => {
      while (live) {
        const path = queue.shift();
        if (path === undefined) return;

        const seconds = await probeDuration(sidecar, path);
        if (!live || seconds === undefined) continue;

        setDurations((current) => {
          const next = new Map(current);
          next.set(path, formatDuration(seconds));
          return next;
        });
      }
    };

    void Promise.all(Array.from({ length: MAX_IN_FLIGHT }, worker));

    return () => {
      live = false;
    };
  }, [tree, sidecar]);

  return durations;
}

/**
 * One probe, or nothing.
 *
 * Never throws and never reports a failure: a file the sidecar cannot read still belongs in the
 * browser, and a row that said `—` where every other row says a time would draw the eye to the one
 * thing the user cannot act on. It simply has no duration, exactly as a note has none.
 */
async function probeDuration(sidecar: SidecarInfo, asset: string): Promise<number | undefined> {
  try {
    const response = await fetch(`${sidecar.baseUrl}/media/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
      body: JSON.stringify({ asset }),
    });
    if (!response.ok) return undefined;

    const body = (await response.json()) as { readonly duration_seconds?: number | null };
    return body.duration_seconds == null ? undefined : body.duration_seconds;
  } catch {
    return undefined;
  }
}
