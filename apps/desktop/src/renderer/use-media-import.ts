import { useCallback, useState } from 'react';
import {
  type AssetPath,
  type FrameIndex,
  type TimelineDocument,
  type TrackId,
  clipId,
  frameRate,
  frameRateToNumber,
} from '@nos/core';
import { firstFreeFrame, importMedia } from '@nos/editing';
import type { SidecarInfo } from '../main/ipc-contract.js';

/**
 * Importing media from the browser onto the timeline.
 *
 * The probe comes first, because what a file *is* decides everything that follows: how long the clip
 * runs, which track it belongs on, and whether it becomes one clip or a linked pair. Guessing from the
 * extension would put a silent `.mp4` on two tracks and a 24 fps clip at the wrong rate.
 *
 * Placement is at the playhead when that is clear and after the material otherwise. Never on top of
 * something: the editing layer refuses a collision, and finding the first free frame first turns that
 * refusal into a result the user wanted rather than an error they have to resolve by hand.
 */

export interface MediaImport {
  readonly importing: boolean;
  readonly error: string | undefined;
  /** Imports an asset, returning the id of the clip a user would think of as "the" clip. */
  run(asset: AssetPath, at: FrameIndex): Promise<string | undefined>;
}

export interface MediaImportOptions {
  readonly document: TimelineDocument;
  readonly sidecar: SidecarInfo | undefined;
  readonly videoTrack: TrackId;
  readonly audioTrack: TrackId;
  readonly commit: (label: string, next: TimelineDocument) => void;
}

/** What the sidecar's probe reports, in the shape this hook needs. */
interface ProbeResult {
  readonly type: 'video' | 'audio' | 'image' | 'text' | 'mask';
  readonly duration_seconds?: number | null;
  readonly video?: { readonly frame_rate?: string | null } | null;
  readonly audio?: unknown;
}

export function useMediaImport(options: MediaImportOptions): MediaImport {
  const { document, sidecar, videoTrack, audioTrack, commit } = options;
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = useCallback(
    async (asset: AssetPath, at: FrameIndex): Promise<string | undefined> => {
      if (sidecar === undefined || !sidecar.available) {
        setError('the media sidecar is not running, so this file cannot be read');
        return undefined;
      }

      setImporting(true);
      setError(undefined);
      try {
        const probe = await probeAsset(sidecar, asset);
        if (probe === undefined) {
          setError(`${asset} could not be read`);
          return undefined;
        }
        if (probe.type !== 'video' && probe.type !== 'audio' && probe.type !== 'image') {
          // A markdown note or a mask is a legitimate project file and not something that goes on a
          // timeline. Saying so is better than a generic failure.
          setError(`${asset} is not something that can go on the timeline`);
          return undefined;
        }

        // Ids derived from the asset and the position, so the same import twice is a collision the
        // editing layer refuses rather than a silent duplicate.
        const base = `${asset.replace(/[^a-z0-9]+/gi, '_')}_${at}`;
        const hasAudio = probe.type === 'video' && probe.audio !== null && probe.audio !== undefined;

        const frames = Math.max(
          1,
          Math.round((probe.duration_seconds ?? 0) * frameRateToNumberSafe(document)),
        );
        const landing = firstFreeFrame(
          document,
          hasAudio || probe.type === 'audio' ? [videoTrack, audioTrack] : [videoTrack],
          at,
          frames,
        );

        const result = importMedia(document, {
          asset,
          type: probe.type,
          ...(probe.duration_seconds != null ? { durationSeconds: probe.duration_seconds } : {}),
          ...(parseRate(probe.video?.frame_rate) !== undefined
            ? { sourceRate: parseRate(probe.video?.frame_rate) }
            : {}),
          hasAudio,
          at: landing,
          videoTrack,
          audioTrack,
          label: asset.slice(asset.lastIndexOf('/') + 1),
          id: clipId(base),
          ...(hasAudio ? { linkedId: clipId(`${base}_audio`) } : {}),
        });

        if (!result.ok) {
          setError(`${asset} could not be placed: ${String(result.error.kind).replace(/-/g, ' ')}`);
          return undefined;
        }

        commit('import media', result.value.document);
        return result.value.clips[0]?.id;
      } finally {
        setImporting(false);
      }
    },
    [audioTrack, commit, document, sidecar, videoTrack],
  );

  return { importing, error, run };
}

async function probeAsset(sidecar: SidecarInfo, asset: AssetPath): Promise<ProbeResult | undefined> {
  try {
    const response = await fetch(`${sidecar.baseUrl}/media/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nos-token': sidecar.token },
      body: JSON.stringify({ asset }),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as ProbeResult;
  } catch {
    return undefined;
  }
}

/**
 * The source's own rate, as an exact rational.
 *
 * ffprobe reports `30000/1001`, and keeping it exact is what makes a 29.97 clip land on the frame it
 * should rather than drifting a frame every thirty seconds.
 */
function parseRate(text: string | null | undefined) {
  if (text === null || text === undefined || text === '') return undefined;
  const [numerator, denominator] = text.split('/').map(Number);
  if (!Number.isFinite(numerator) || numerator === undefined || numerator <= 0) return undefined;
  return frameRate(numerator, denominator === undefined || denominator === 0 ? 1 : denominator);
}

/** The project's rate as a number, for sizing. */
function frameRateToNumberSafe(document: TimelineDocument): number {
  return frameRateToNumber(document.frameRate);
}
