import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Clip,
  type FrameRate,
  type TimelineDocument,
  clipSource,
  frameRateToNumber,
  trackClips,
} from '@nos/core';
import type { SourceBoundsResolver } from '@nos/editing';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * How long each source actually is, in frames, so an edit can be stopped at the end of its media.
 *
 * `SourceBoundsResolver` has existed since M2 and the trims have always consulted it — `trimClip`
 * refuses to pull an edge past the end of a file and names how many frames were missing. **Nothing ever
 * supplied one.** Every trim in the application ran with `options.sources` undefined, which the resolver
 * documents as "proceed unchecked", so an edge could be dragged well past the end of a shot and the
 * refusal that was written for exactly that never fired.
 *
 * The guard was there and the data was not, which is the same shape as every other gap this project has
 * turned up: a mechanism finished, tested, and never connected to the thing it protects.
 *
 * ## Frames, not seconds
 *
 * A bound is a count of frames *at the source's own rate*, because that is what `sourceIn` and a trim
 * delta are measured in. The probe reports a video's frame count directly; for audio there are no frames
 * to count, so the duration is converted at the source's declared rate — the same rate the document
 * already records for the clip.
 */

export interface SourceBounds {
  readonly totalFrames: number;
}

/**
 * What a probe found, before it is expressed in anybody's frames.
 *
 * A video reports its own frame count and that is the number a trim is measured against. Audio has no
 * frames, only a duration — and the rate to convert it at belongs to the *clip*, not to the file, because
 * `source.sourceRate` is what `sourceIn` on that clip already counts in. So the cache keeps whichever the
 * probe gave, and the conversion happens where the clip is in hand.
 */
export interface ProbedLength {
  readonly frames?: number;
  readonly seconds?: number;
}

/** Probed lengths by project-relative asset path. */
export type SourceLengths = ReadonlyMap<string, ProbedLength>;

export interface SourceBoundsState {
  readonly lengths: SourceLengths;
  /**
   * The resolver to hand to an edit.
   *
   * Answers `undefined` for anything not yet probed, which is what keeps editing usable while the
   * probes land: an unprobed source is not a short one, and refusing every trim until the sidecar has
   * answered would be worse than the missing guard it replaces.
   */
  readonly resolver: SourceBoundsResolver;
}

export function useSourceBounds(
  document: TimelineDocument,
  sidecar: SidecarInfo | undefined,
): SourceBoundsState {
  const [lengths, setLengths] = useState<SourceLengths>(() => new Map());

  /** Every asset ever asked about, so a watcher event does not re-probe the whole project. */
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (sidecar === undefined || !sidecar.available) return;

    const wanted = [...timedAssets(document)].filter((asset) => !asked.current.has(asset));
    if (wanted.length === 0) return;
    for (const asset of wanted) asked.current.add(asset);

    let live = true;
    void probeAll(sidecar, wanted).then((found) => {
      if (!live || found.size === 0) return;
      setLengths((current) => new Map([...current, ...found]));
    });

    return () => {
      live = false;
    };
  }, [document, sidecar]);

  return useMemo(
    () => ({
      lengths,
      resolver: {
        boundsFor: (clip: Clip) => {
          const source = clipSource(clip);
          if (source === undefined) return undefined;
          return boundsFrom(lengths.get(String(source.asset)), source.sourceRate);
        },
      },
    }),
    [lengths],
  );
}

/** Video and audio only: a title has no file, and a still is meant to be held. */
function timedAssets(document: TimelineDocument): ReadonlySet<string> {
  const assets = new Set<string>();
  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
      const source = clipSource(clip);
      if (source !== undefined) assets.add(String(source.asset));
    }
  }
  return assets;
}

async function probeAll(sidecar: SidecarInfo, assets: readonly string[]): Promise<Map<string, ProbedLength>> {
  const found = new Map<string, ProbedLength>();
  for (const asset of assets) {
    const bounds = await probe(sidecar, asset);
    if (bounds !== undefined) found.set(asset, bounds);
  }
  return found;
}

/**
 * One probe, turned into a frame count.
 *
 * Never throws and never reports. A source the sidecar cannot read has no bound, which means edits on it
 * proceed as they did before this existed — the missing guard is the old behaviour, and it is better than
 * refusing to trim a clip because a probe failed.
 */
async function probe(sidecar: SidecarInfo, asset: string): Promise<ProbedLength | undefined> {
  try {
    const response = await fetch(`${sidecar.baseUrl}/media/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
      body: JSON.stringify({ asset }),
    });
    if (!response.ok) return undefined;

    const body = (await response.json()) as {
      readonly duration_seconds?: number | null;
      readonly video?: { readonly frames?: number | null; readonly frame_rate?: string | null } | null;
      readonly audio?: { readonly sample_rate?: number | null } | null;
    };

    const frames = body.video?.frames;
    if (typeof frames === 'number' && frames > 0) return { frames };

    const seconds = body.duration_seconds;
    if (typeof seconds === 'number' && seconds > 0) return { seconds };
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * A probed length expressed in the frames a *clip* counts in.
 *
 * Separated from the hook because it is the part with a decision in it, and the decision is easy to get
 * wrong: the rate belongs to the clip, not to the file. `source.sourceRate` is what that clip's
 * `sourceIn` and every trim delta on it are measured in, so a hard-coded 30 would be right for a web
 * project and wrong for every other rate in the same document.
 *
 * A video's own frame count wins outright — it is the exact number, with no conversion to be wrong
 * about. Seconds are the fallback, and they are floored: reporting one frame more than exists would
 * un-guard the last frame, which is precisely the frame a trim runs into.
 */
export function boundsFrom(probed: ProbedLength | undefined, rate: FrameRate): SourceBounds | undefined {
  if (probed === undefined) return undefined;
  if (probed.frames !== undefined) return { totalFrames: probed.frames };
  if (probed.seconds === undefined) return undefined;

  const frames = Math.floor(probed.seconds * frameRateToNumber(rate));
  // A source shorter than one frame bounds nothing usable, and answering zero would refuse every edit
  // on it rather than leaving it unchecked as an unprobed source is.
  return frames > 0 ? { totalFrames: frames } : undefined;
}
