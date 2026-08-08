import { useEffect, useRef, useState } from 'react';
import {
  type AssetPath,
  type Clip,
  type TimelineDocument,
  clipSource,
  clipSpeed,
  framesToSecondsNumber,
} from '@nos/core';
import { decodePeaks } from '@nos/sidecar-client';
import { type ClipStrip, fittedStrip, spanningStrip } from '@nos/ui';
import { drawWaveform, filmstripHeightFor, thumbnailsPerSecondFor } from './clip-strips.js';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * Filmstrips and waveforms for the clips on screen.
 *
 * The mockups show them and they are not decoration: a timeline of flat rectangles gives no way to find
 * a shot or a beat without scrubbing, which is most of what editing is.
 *
 * Two paths, because the sidecar caches two different things for good reasons. A **filmstrip** is an
 * image of the whole asset, so it is used directly and *placed* against the range its clip shows. A
 * **waveform** is cached as peaks rather than as a picture, because peaks are resolution-independent —
 * one derivation serves every zoom, where an image would have to be regenerated for each — so the
 * picture is drawn here at the size the clip is actually shown.
 *
 * Derivation is per *asset*, never per clip. Two cuts of the same file share one filmstrip; deriving per
 * clip would run ffmpeg once per cut and fill `cache/` with copies.
 */

export interface ClipStrips {
  /** Strips by clip id, in the shape the timeline takes. Absent means not derived yet. */
  readonly strips: ReadonlyMap<string, ClipStrip>;
  readonly failures: readonly string[];
}

export interface ClipStripsOptions {
  readonly document: TimelineDocument;
  readonly sidecar: SidecarInfo | undefined;
  readonly framesPerPixel: number;
  /** Pixels per frame times clip length, so a waveform is drawn at the width it is shown. */
  readonly widthForClip: (clip: Clip) => number;
}

interface Derived {
  readonly url: string;
  /** Object URLs must be revoked, file URLs must not. Recorded so cleanup does the right one. */
  readonly revoke: boolean;
  /** For a filmstrip, how much source time the image holds. Absent for a per-clip drawing. */
  readonly sourceSeconds?: number;
}

/** What `/media/derive` answers with. */
interface DerivedArtifact {
  readonly path: string;
  readonly filmstrip?: { readonly duration_seconds: number } | null;
}

export function useClipStrips(options: ClipStripsOptions): ClipStrips {
  const { document, sidecar, framesPerPixel, widthForClip } = options;
  const [strips, setStrips] = useState<ReadonlyMap<string, ClipStrip>>(new Map());
  const [failures, setFailures] = useState<readonly string[]>([]);

  // Keyed by asset and spec, so two cuts of one file share a derivation and a zoom change reuses what
  // is already there.
  const cache = useRef(new Map<string, Derived>());

  useEffect(() => {
    if (sidecar === undefined || !sidecar.available) return;
    let cancelled = false;

    const clips = document.sequence.tracks.flatMap((track) =>
      (track.clips as readonly Clip[]).map((clip) => ({ clip, height: track.height })),
    );

    void (async () => {
      const next = new Map<string, ClipStrip>();
      const problems: string[] = [];

      for (const { clip, height } of clips) {
        const source = clipSource(clip);
        if (source === undefined) continue;

        // What the clip shows of its source, which is what a strip has to be placed against. The
        // speed factor belongs here: a clip at half speed shows half as much source as its length
        // on the timeline suggests, and a strip that ignored it would drift across the clip.
        const shownSeconds = framesToSecondsNumber(clip.span.duration, document.frameRate) * clipSpeed(clip);
        const startSeconds = framesToSecondsNumber(source.sourceIn, source.sourceRate);

        try {
          const strip =
            clip.kind === 'audio'
              ? await waveformStrip(sidecar, source.asset, cache.current, {
                  widthPx: Math.round(widthForClip(clip)),
                  heightPx: Math.max(12, height - 12),
                  startSeconds,
                  durationSeconds: shownSeconds,
                })
              : await filmstripStrip(sidecar, source.asset, cache.current, {
                  heightPx: filmstripHeightFor(height),
                  perSecond: thumbnailsPerSecondFor(
                    framesPerPixel,
                    document.frameRate.value.numerator / document.frameRate.value.denominator,
                  ),
                  startSeconds,
                  shownSeconds,
                });

          if (strip !== undefined) next.set(clip.id, strip);
        } catch (error) {
          // Reported, not thrown: a clip without a filmstrip is still editable, and taking the timeline
          // down because ffmpeg refused one file would be a far worse trade.
          problems.push(`${source.asset}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (cancelled) return;
      setStrips(next);
      setFailures(problems);
    })();

    return () => {
      cancelled = true;
    };
  }, [document, sidecar, framesPerPixel, widthForClip]);

  // Object URLs are revoked only when the hook is torn down, not per render: a waveform survives a
  // scrub, and revoking on every document change would blank every clip while it redraws.
  useEffect(() => {
    const held = cache.current;
    return () => {
      for (const entry of held.values()) if (entry.revoke) URL.revokeObjectURL(entry.url);
      held.clear();
    };
  }, []);

  return { strips, failures };
}

async function filmstripStrip(
  sidecar: SidecarInfo,
  asset: AssetPath,
  cache: Map<string, Derived>,
  spec: {
    readonly heightPx: number;
    readonly perSecond: number;
    readonly startSeconds: number;
    readonly shownSeconds: number;
  },
): Promise<ClipStrip | undefined> {
  const key = `filmstrip:${asset}:${spec.heightPx}:${spec.perSecond}`;
  const cached = cache.get(key) ?? (await deriveFilmstrip(sidecar, asset, spec, cache, key));
  if (cached?.sourceSeconds === undefined) return undefined;

  return spanningStrip(cached.url, {
    sourceSeconds: cached.sourceSeconds,
    startSeconds: spec.startSeconds,
    shownSeconds: spec.shownSeconds,
  });
}

async function deriveFilmstrip(
  sidecar: SidecarInfo,
  asset: AssetPath,
  spec: { readonly heightPx: number; readonly perSecond: number },
  cache: Map<string, Derived>,
  key: string,
): Promise<Derived | undefined> {
  const artifact = await derive(sidecar, asset, {
    kind: 'filmstrip',
    thumbnail_height: spec.heightPx,
    thumbnails_per_second: spec.perSecond,
  });
  // A strip whose span the sidecar did not report is not drawn at all. It could only be stretched or
  // tiled, and both put pictures under moments they do not belong to — worse than nothing, because a
  // user reads a filmstrip to find a cut point.
  if (artifact?.filmstrip == null) return undefined;

  const entry: Derived = {
    url: fileUrl(sidecar, artifact.path),
    revoke: false,
    sourceSeconds: artifact.filmstrip.duration_seconds,
  };
  cache.set(key, entry);
  return entry;
}

async function waveformStrip(
  sidecar: SidecarInfo,
  asset: AssetPath,
  cache: Map<string, Derived>,
  spec: {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly startSeconds: number;
    readonly durationSeconds: number;
  },
): Promise<ClipStrip | undefined> {
  // The drawn range is part of the key along with the size, because the picture is made for exactly
  // this clip at exactly this zoom. The peaks behind it are derived once and only re-drawn.
  const key = `waveform:${asset}:${spec.widthPx}:${spec.heightPx}:${spec.startSeconds}:${spec.durationSeconds}`;
  const cached = cache.get(key);
  if (cached !== undefined) return fittedStrip(cached.url);

  const artifact = await derive(sidecar, asset, { kind: 'waveform', buckets_per_second: 100 });
  if (artifact === undefined) return undefined;

  const response = await fetch(fileUrl(sidecar, artifact.path));
  if (!response.ok) return undefined;

  const decoded = decodePeaks(await response.arrayBuffer());
  if (!decoded.ok) return undefined;

  const canvas = drawWaveform({
    peaks: decoded.value,
    widthPx: spec.widthPx,
    heightPx: spec.heightPx,
    startSeconds: spec.startSeconds,
    durationSeconds: spec.durationSeconds,
  });
  if (canvas === undefined) return undefined;

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) return undefined;

  const url = URL.createObjectURL(blob);
  cache.set(key, { url, revoke: true });
  return fittedStrip(url);
}

async function derive(
  sidecar: SidecarInfo,
  asset: AssetPath,
  spec: Record<string, unknown>,
): Promise<DerivedArtifact | undefined> {
  const response = await fetch(`${sidecar.baseUrl}/media/derive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
    body: JSON.stringify({ asset, spec }),
  });
  if (!response.ok) return undefined;
  return (await response.json()) as DerivedArtifact;
}

/** The token travels in the query here, because an `<img src>` cannot send a header. */
function fileUrl(sidecar: SidecarInfo, asset: string): string {
  return `${sidecar.baseUrl}/media/file?asset=${encodeURIComponent(asset)}&token=${encodeURIComponent(sidecar.token)}`;
}
