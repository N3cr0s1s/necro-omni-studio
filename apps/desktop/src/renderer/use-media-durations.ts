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
 * duration is not on disk — it is in the container, and reading it means asking the sidecar. Putting
 * it in the walk would make opening a project wait for a probe of every asset in it.
 *
 * So durations arrive **after** the tree and independently of it, and a row simply has none until the
 * answer lands. That is also why this returns a map rather than a decorated tree: the tree is rebuilt
 * on every watcher event, and a decorated copy would have to be rebuilt with it.
 *
 * ## Why one request rather than one per file
 *
 * The first version probed each file separately, and it was wrong in a way worth recording. A project
 * legitimately holds media with no readable duration — a placeholder a generator has not written yet,
 * a file still being encoded, a container ffprobe does not understand — and `/media/probe` answers
 * those with a 404 or a 422, correctly, because *that* endpoint's question is "the metadata, or why
 * not". **A browser logs every 4xx to its console whatever the caller does with the promise**, so a
 * single unreadable file in a project turned into a renderer error on every scan, which the export
 * check counts and rightly failed on.
 *
 * The fix was not to swallow the error but to ask a different question. A listing wants "the duration
 * if there is one", and `/media/durations` answers `null` where there is none — no error, nothing
 * logged, and one round trip for a folder of two hundred takes instead of two hundred.
 */

/** Formatted durations by project-relative path. Absent means not answered yet, or not media. */
export type MediaDurations = ReadonlyMap<string, string>;

/** Only these are asked about. A markdown note has no duration and asking about one is a wasted call. */
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
   * each rebuild would ask about every file in the project again. A ref rather than state because
   * reading it must not schedule a render.
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
    void readDurations(sidecar, wanted).then((answers) => {
      if (!live || answers.size === 0) return;
      setDurations((current) => new Map([...current, ...answers]));
    });

    return () => {
      live = false;
    };
  }, [tree, sidecar]);

  return durations;
}

/**
 * Asks for the whole batch, and formats what came back.
 *
 * Never throws. A sidecar that is starting, or has gone, leaves the rows as they were — a duration is
 * a label, and losing the ones already on screen because a later batch failed would be worse than
 * showing nothing new.
 */
async function readDurations(
  sidecar: SidecarInfo,
  assets: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const formatted = new Map<string, string>();
  try {
    const response = await fetch(`${sidecar.baseUrl}/media/durations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
      body: JSON.stringify({ assets }),
    });
    if (!response.ok) return formatted;

    const body = (await response.json()) as {
      readonly durations?: Readonly<Record<string, number | null>>;
    };
    for (const [asset, seconds] of Object.entries(body.durations ?? {})) {
      // `null` is the honest answer for a file with no readable stream, and it stays absent from the
      // map so the row shows nothing rather than a zero.
      if (seconds !== null && seconds !== undefined) formatted.set(asset, formatDuration(seconds));
    }
  } catch {
    // Nothing to add. Reported nowhere, because a missing duration is not something a user can act on.
  }
  return formatted;
}
