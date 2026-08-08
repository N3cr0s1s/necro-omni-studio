import { useEffect, useMemo, useRef, useState } from 'react';
import { type AssetPath, type Clip, type TimelineDocument, assetPath, clipSource } from '@nos/core';
import { DEFAULT_PROXY, type ProxySpec } from '@nos/media';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * Editing proxies.
 *
 * The spec asks for realtime 1080p/30 preview **from proxies**, and the sidecar has been able to make
 * them since M2 — `/media/derive` transcodes to a constrained short edge and caches by content hash,
 * verified against real ffmpeg for landscape and portrait alike. Nothing ever asked it to. The
 * preview decoded whatever the user imported, so a 4K source was decoded at 4K to fill a canvas a
 * thousand pixels wide.
 *
 * Two rules keep this from being worse than no proxies at all.
 *
 * **The original is used until its proxy exists.** A transcode takes as long as it takes, and a
 * preview that went blank while it ran would trade a slow picture for no picture.
 *
 * **The export never substitutes one.** The WYSIWYG guarantee is that preview and delivery run the
 * same plan; quietly encoding the delivery from a downscaled intermediate would break it invisibly,
 * which is the worst way for it to break. Export takes proxies only when the user asks, through the
 * setting that already exists for it.
 */

export interface Proxies {
  /**
   * The asset to decode in place of a source asset.
   *
   * Total rather than partial: an asset with no proxy resolves to itself, so callers substitute
   * unconditionally instead of each deciding what a missing entry means.
   */
  resolve(asset: AssetPath): AssetPath;
  /** Assets still being transcoded, for a status line that explains why preview is heavy. */
  readonly pending: readonly AssetPath[];
  readonly ready: number;
  readonly failures: readonly string[];
}

export interface ProxyOptions {
  readonly document: TimelineDocument;
  readonly sidecar: SidecarInfo | undefined;
  readonly spec?: ProxySpec;
  /** Off for a session that wants the original media, e.g. a final quality check. */
  readonly enabled?: boolean;
}

/** What a probe tells us about a source, in the shape the decision needs. */
export interface SourceSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Whether a source is worth proxying.
 *
 * Only when the proxy would actually be smaller. Re-encoding a 720p source to a 1080p proxy costs a
 * full transcode, loses a generation of quality, and hands the decoder the same number of pixels — a
 * clear loss on every axis. Frame rate is deliberately *not* part of this: dropping a 60 fps source
 * to 30 changes which frame lands on a timeline frame, and a preview that showed different frames
 * from the export would break the guarantee the proxy exists to protect.
 */
export function shouldProxy(size: SourceSize | undefined, spec: ProxySpec = DEFAULT_PROXY): boolean {
  if (size === undefined) return false;
  const shortEdge = Math.min(size.width, size.height);
  return shortEdge > spec.shortEdge;
}

/** Distinct video assets on the timeline. Images and audio have nothing to proxy. */
export function proxyCandidates(document: TimelineDocument): readonly AssetPath[] {
  const assets = new Set<AssetPath>();
  for (const track of document.sequence.tracks) {
    for (const clip of track.clips as readonly Clip[]) {
      if (clip.kind !== 'video') continue;
      const source = clipSource(clip);
      if (source !== undefined) assets.add(source.asset);
    }
  }
  return [...assets];
}

export function useProxies(options: ProxyOptions): Proxies {
  const { document, sidecar, spec = DEFAULT_PROXY, enabled = true } = options;
  const [ready, setReady] = useState<ReadonlyMap<AssetPath, AssetPath>>(new Map());
  const [pending, setPending] = useState<readonly AssetPath[]>([]);
  const [failures, setFailures] = useState<readonly string[]>([]);

  // Assets already decided about, so a document change does not re-probe or re-derive what is done.
  // Keyed by asset and spec: changing the proxy setting must genuinely produce new proxies.
  const settled = useRef(new Map<string, AssetPath | undefined>());

  const candidates = useMemo(() => proxyCandidates(document), [document]);
  const specKey = `${spec.shortEdge}:${spec.frameRate}:${spec.quality}`;

  useEffect(() => {
    if (!enabled || sidecar === undefined || !sidecar.available) return;
    let cancelled = false;

    void (async () => {
      const outstanding = candidates.filter((asset) => !settled.current.has(`${specKey}:${asset}`));
      if (outstanding.length === 0) return;
      if (!cancelled) setPending(outstanding);

      // One at a time. A transcode is the heaviest thing this application asks the machine to do, and
      // ten of them in parallel for a ten-clip timeline would starve the preview they exist to serve
      // — while finishing no sooner, since they contend for the same cores.
      for (const asset of outstanding) {
        if (cancelled) return;
        const key = `${specKey}:${asset}`;

        try {
          const size = await probeSize(sidecar, asset);
          if (!shouldProxy(size, spec)) {
            settled.current.set(key, undefined);
            continue;
          }

          const derived = await deriveProxy(sidecar, asset, spec);
          settled.current.set(key, derived);
          if (derived !== undefined && !cancelled) {
            setReady((current) => new Map(current).set(asset, derived));
          }
        } catch (error) {
          // Recorded and skipped. A source that cannot be proxied is still editable from its
          // original, which is a far better outcome than refusing to show it.
          settled.current.set(key, undefined);
          if (!cancelled) {
            setFailures((current) => [
              ...current,
              `${asset}: ${error instanceof Error ? error.message : String(error)}`,
            ]);
          }
        } finally {
          if (!cancelled) setPending((current) => current.filter((entry) => entry !== asset));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [candidates, sidecar, specKey, spec, enabled]);

  return useMemo(
    () => ({
      resolve: (asset) => ready.get(asset) ?? asset,
      pending,
      ready: ready.size,
      failures,
    }),
    [ready, pending, failures],
  );
}

async function probeSize(sidecar: SidecarInfo, asset: AssetPath): Promise<SourceSize | undefined> {
  const response = await fetch(`${sidecar.baseUrl}/media/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
    body: JSON.stringify({ asset }),
  });
  if (!response.ok) return undefined;

  const body = (await response.json()) as {
    readonly video?: { readonly width?: number; readonly height?: number } | null;
  };
  const video = body.video;
  if (video?.width === undefined || video.height === undefined) return undefined;
  return { width: video.width, height: video.height };
}

async function deriveProxy(
  sidecar: SidecarInfo,
  asset: AssetPath,
  spec: ProxySpec,
): Promise<AssetPath | undefined> {
  const response = await fetch(`${sidecar.baseUrl}/media/derive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
    body: JSON.stringify({
      asset,
      spec: {
        kind: 'proxy',
        short_edge: spec.shortEdge,
        frame_rate: spec.frameRate,
        quality: spec.quality,
      },
    }),
  });
  if (!response.ok) return undefined;

  const artifact = (await response.json()) as { readonly path?: string };
  return artifact.path === undefined ? undefined : assetPath(artifact.path);
}

/** One line for the status area, or nothing when there is nothing to say. */
export function describeProxies(proxies: Proxies): string | undefined {
  if (proxies.failures.length > 0) {
    return proxies.failures.length === 1
      ? `no proxy for ${proxies.failures[0]}`
      : `no proxy for ${proxies.failures.length} sources — ${proxies.failures[0]}`;
  }
  if (proxies.pending.length === 0) return undefined;
  // Named, not counted alone: "building 1 proxy" leaves the user guessing which source is heavy.
  return proxies.pending.length === 1
    ? `building an editing proxy for ${proxies.pending[0]}`
    : `building editing proxies · ${proxies.pending.length} remaining`;
}
