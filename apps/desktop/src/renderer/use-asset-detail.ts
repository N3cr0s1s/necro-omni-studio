import { useEffect, useRef, useState } from 'react';
import type { AssetPath } from '@nos/core';
import { type AssetProvenance, parseProvenance, provenancePath } from '@nos/generators';
import { type MarkdownBlock, isMarkdown, parseMarkdown } from '@nos/media';
import type { DesktopBridge, SidecarInfo } from '../main/ipc-contract.js';
import { shouldProxy } from './use-proxies.js';

/**
 * What the browser can say about the selected file.
 *
 * The detail pane and `summarizeMetadata` have both existed since M2 and neither was ever reached:
 * selecting a file in the browser did nothing at all. So a user could not tell a 4K source from a
 * proxy-sized one, or find out whether a clip would play back smoothly — which is the question the
 * spec says this pane exists to answer.
 *
 * Derived artifacts are detected by **looking**, never by asking for them. `/media/derive` would
 * produce the missing one, turning "is there a proxy?" into a minutes-long transcode nobody asked
 * for, so presence is read off the cache listing instead.
 */

export interface AssetDetail {
  readonly name: string;
  readonly summary: string | undefined;
  readonly hash: string | undefined;
  readonly hasProxy: boolean | undefined;
  readonly hasFilmstrip: boolean | undefined;
  readonly isGenerated: boolean;
  /**
   * What made this file, when it was made by a generator.
   *
   * Read rather than inferred: the file's name is a job id, so without the record beside it there is
   * nothing to reconstruct a prompt or a seed from.
   */
  readonly provenance: AssetProvenance | undefined;
  /**
   * The note's own content, when the selected file is one.
   *
   * The spec reserves `notes/` for "szabad tartalom: markdown, referenciák, bármi" and asks the
   * browser to show it. Parsed here rather than in the panel so the panel stays presentational, and
   * because a note's *title* — its first heading — is worth having wherever there is room for one line
   * and not for a document.
   */
  readonly note: readonly MarkdownBlock[] | undefined;
}

export interface AssetDetailOptions {
  readonly asset: AssetPath | undefined;
  readonly sidecar: SidecarInfo | undefined;
  /** Listing of `cache/`, so artifact presence needs no extra round trip. */
  readonly cacheEntries: readonly string[];
  /** Reads a project file, for the provenance record beside a generated one. */
  readonly readText?: (path: string) => Promise<string | undefined>;
}

/**
 * Whether a derivation of some kind exists for a content hash.
 *
 * Matched on kind and hash rather than on an exact filename, because the *spec* in between varies:
 * the filmstrip's thumbnail rate follows the zoom level, so an exact-name check would report "no
 * filmstrip" for an asset that has three. What the pane answers is "has this been derived", and any
 * spec answers it.
 */
export function hasDerivation(entries: readonly string[], kind: string, hash: string): boolean {
  const digest = hash.slice(0, 16);
  return entries.some((entry) => {
    const name = entry.slice(entry.lastIndexOf('/') + 1);
    if (!name.startsWith(`${kind}_`)) return false;
    const stem = name.slice(0, name.lastIndexOf('.') === -1 ? undefined : name.lastIndexOf('.'));
    return stem.endsWith(`_${digest}`);
  });
}

/** Generated material is purple everywhere in this application; the browser is not an exception. */
export function isGeneratedAsset(asset: AssetPath): boolean {
  return asset.startsWith('generated/');
}

export function useAssetDetail(options: AssetDetailOptions): AssetDetail | undefined {
  const { asset, sidecar, cacheEntries, readText } = options;
  const [probed, setProbed] = useState<Probed | undefined>(undefined);
  const [provenance, setProvenance] = useState<AssetProvenance | undefined>(undefined);
  const [note, setNote] = useState<readonly MarkdownBlock[] | undefined>(undefined);

  // Looked for on every file, not only those under `generated/`: a generated clip the user moved or
  // renamed keeps its record beside it, and refusing to read one because of where the file now sits
  // would lose exactly the history this exists to keep.
  useEffect(() => {
    if (asset === undefined || readText === undefined) {
      setProvenance(undefined);
      return;
    }

    let cancelled = false;
    setProvenance(undefined);

    void readText(provenancePath(asset)).then((text) => {
      if (cancelled || text === undefined) return;
      const parsed = parseProvenance(text);
      // A record written by an older version or edited by hand leaves the pane silent rather than
      // broken: the file it describes is still perfectly usable.
      if (parsed.ok) setProvenance(parsed.value);
    });

    return () => {
      cancelled = true;
    };
  }, [asset, readText]);

  // Read whole, because a note is prose: there is no header to sample and no size at which showing
  // the first half would be more useful than showing none. A note large enough to matter is a note
  // somebody wrote by hand.
  useEffect(() => {
    if (asset === undefined || readText === undefined || !isMarkdown(asset)) {
      setNote(undefined);
      return;
    }

    let cancelled = false;
    setNote(undefined);

    void readText(asset).then((text) => {
      // An unreadable note leaves the pane as it was rather than reporting a failure: the file is
      // still in the tree, and the watcher will say if it goes.
      if (!cancelled && text !== undefined) setNote(parseMarkdown(text));
    });

    return () => {
      cancelled = true;
    };
  }, [asset, readText]);

  // Probes are cached per asset for the session. A file's metadata changes only when the file does,
  // and the watcher already reports that — re-probing on every selection would run ffprobe each time
  // a user arrows through a folder.
  const cache = useRef(new Map<string, Probed>());

  useEffect(() => {
    if (asset === undefined || sidecar === undefined || !sidecar.available) {
      setProbed(undefined);
      return;
    }

    const cached = cache.current.get(asset);
    if (cached !== undefined) {
      setProbed(cached);
      return;
    }

    let cancelled = false;
    setProbed(undefined);

    void probe(sidecar, asset).then((result) => {
      if (cancelled || result === undefined) return;
      cache.current.set(asset, result);
      setProbed(result);
    });

    return () => {
      cancelled = true;
    };
  }, [asset, sidecar]);

  if (asset === undefined) return undefined;

  return {
    name: asset.slice(asset.lastIndexOf('/') + 1),
    summary: probed?.summary,
    hash: probed?.hash,
    // Undefined until the hash is known, which the pane renders as "pending" rather than "missing" —
    // the two are different answers to "will this play back smoothly".
    // Absent, not pending, for a source small enough to need none: there is no proxy question for a
    // 720p file, and a "…" that never resolved would read as work stuck rather than work not needed.
    hasProxy:
      probed === undefined || !shouldProxy(probed.size)
        ? undefined
        : hasDerivation(cacheEntries, 'proxy', probed.hash),
    hasFilmstrip: probed === undefined ? undefined : hasDerivation(cacheEntries, 'filmstrip', probed.hash),
    // Either the folder or a record says so. A generated file moved out of `generated/` is still
    // generated, and the purple treatment follows the provenance rather than the path.
    isGenerated: isGeneratedAsset(asset) || provenance !== undefined,
    provenance,
    note,
  };
}

/** What the sidecar's probe answers, in the shape the pane needs. */
interface ProbeBody {
  readonly type: string;
  readonly hash: string;
  readonly duration_seconds?: number | null;
  readonly video?: { readonly width: number; readonly height: number; readonly codec: string } | null;
  readonly audio?: {
    readonly sample_rate: number;
    readonly channels: number;
    readonly codec: string;
  } | null;
  readonly image?: { readonly width: number; readonly height: number; readonly codec: string } | null;
}

interface Probed {
  readonly summary: string;
  readonly hash: string;
  /** Present for video, so the pane can tell "no proxy yet" from "no proxy needed". */
  readonly size: { readonly width: number; readonly height: number } | undefined;
}

async function probe(sidecar: SidecarInfo, asset: AssetPath): Promise<Probed | undefined> {
  try {
    const response = await fetch(`${sidecar.baseUrl}/media/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
      body: JSON.stringify({ asset }),
    });
    if (!response.ok) return undefined;

    const body = (await response.json()) as ProbeBody;
    return {
      summary: summarize(body),
      hash: body.hash,
      size: body.video == null ? undefined : { width: body.video.width, height: body.video.height },
    };
  } catch {
    // A probe that fails leaves the pane showing the file's name and nothing else, which is honest.
    // A note or an unreadable file is not a defect worth interrupting the browser for.
    return undefined;
  }
}

/**
 * A one-line description of a file.
 *
 * Duration is included wherever it exists, because "how long is this" is the question asked most
 * often of a file about to go on a timeline — and it is the one thing the name never tells you.
 */
export function summarize(body: ProbeBody): string {
  const duration = body.duration_seconds == null ? undefined : formatDuration(body.duration_seconds);

  if (body.video != null) {
    return [`${body.video.width}×${body.video.height}`, body.video.codec, duration]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
  }
  if (body.audio != null) {
    const channels = body.audio.channels === 1 ? 'mono' : `${body.audio.channels} ch`;
    return [`${body.audio.sample_rate} Hz`, channels, body.audio.codec, duration]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
  }
  if (body.image != null) {
    return `${body.image.width}×${body.image.height} · ${body.image.codec}`;
  }
  return body.type;
}

/**
 * The names in `cache/`.
 *
 * Listed rather than read off the browser's tree: the tree deliberately hides cache *contents*, so
 * its `cache` node has no children to inspect. Refreshed on `revision`, which the shell bumps as
 * derivations land.
 */
export function useCacheListing(
  bridge: DesktopBridge | undefined,
  projectRoot: string | undefined,
  revision: number,
): readonly string[] {
  const [entries, setEntries] = useState<readonly string[]>([]);

  useEffect(() => {
    if (bridge === undefined || projectRoot === undefined) {
      setEntries([]);
      return;
    }
    let cancelled = false;

    void bridge
      .listFolder('cache')
      .then((listing) => {
        if (!cancelled) setEntries(listing.map((entry) => entry.path));
      })
      .catch(() => {
        // A project with no cache folder yet is the normal case on first open, not a failure.
        if (!cancelled) setEntries([]);
      });

    return () => {
      cancelled = true;
    };
  }, [bridge, projectRoot, revision]);

  return entries;
}

/** `1:23` rather than `83.4 s`: the readout is compared against a timeline, not summed. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}
