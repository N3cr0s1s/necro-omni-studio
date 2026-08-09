import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type TimelineDocument,
  type Track,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  endExclusive,
  frameIndex,
  locateClip,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import type { SourceBoundsResolver } from './clip-ops.js';
import { reachableTrimDelta, trimGroup } from './trim-group.js';

/**
 * Trimming a linked pair.
 *
 * The bug this covers is not a refusal but a *success* that half happened: the picture got shorter
 * and its own sound did not. Every assertion here therefore reads both halves, because reading one
 * is exactly what missed it.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, from: number, to: number, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(from), frameIndex(to)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(60), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

function audio(id: string, from: number, to: number, extra: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(from), frameIndex(to)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(60), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...extra,
  } as AudioClip;
}

function documentWith(clips: readonly Clip[], audioClips: readonly AudioClip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) => {
        if (track.kind === 'video' && clips.length > 0) return { ...track, clips } as Track;
        if (track.kind === 'audio' && audioClips.length > 0) return { ...track, clips: audioClips } as Track;
        return track;
      }),
    },
  };
}

/** An imported video and the audio split out of it: same file, same span, linked both ways. */
function pair(extraVideo: Partial<Clip> = {}, extraAudio: Partial<AudioClip> = {}): TimelineDocument {
  return documentWith(
    [video('v', 100, 200, { linkedAudio: clipId('a'), ...extraVideo } as Partial<Clip>)],
    [audio('a', 100, 200, { linkedVideo: clipId('v'), ...extraAudio })],
  );
}

function spanOf(document: TimelineDocument, id: string): readonly [number, number] {
  const located = locateClip(document, clipId(id));
  if (located === undefined) throw new Error(`no clip ${id}`);
  return [located.clip.span.start, endExclusive(located.clip.span)];
}

describe('trimming a linked pair', () => {
  it('moves both heads, grabbed from either side', () => {
    const fromVideo = trimGroup({ document: pair(), clip: clipId('v'), edge: 'start', delta: 20 });
    expect(fromVideo.ok).toBe(true);
    if (!fromVideo.ok) return;
    expect(spanOf(fromVideo.value, 'v')).toEqual([120, 200]);
    expect(spanOf(fromVideo.value, 'a')).toEqual([120, 200]);

    // Grabbing the sound has to reach the picture, or the fix only covers the half a test happened
    // to drive.
    const fromAudio = trimGroup({ document: pair(), clip: clipId('a'), edge: 'start', delta: 20 });
    expect(fromAudio.ok).toBe(true);
    if (!fromAudio.ok) return;
    expect(spanOf(fromAudio.value, 'v')).toEqual([120, 200]);
    expect(spanOf(fromAudio.value, 'a')).toEqual([120, 200]);
  });

  it('moves both tails', () => {
    const result = trimGroup({ document: pair(), clip: clipId('v'), edge: 'end', delta: -30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'v')).toEqual([100, 170]);
    expect(spanOf(result.value, 'a')).toEqual([100, 170]);
  });

  it('applies the delta, so a deliberate offset survives the trim', () => {
    // Sound that runs two frames ahead of the picture is a cut somebody made on purpose. Writing one
    // clip's new edge onto the other would silently undo it.
    const offset = documentWith(
      [video('v', 100, 200, { linkedAudio: clipId('a') } as Partial<Clip>)],
      [audio('a', 98, 200, { linkedVideo: clipId('v') })],
    );
    const result = trimGroup({ document: offset, clip: clipId('v'), edge: 'start', delta: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'v')).toEqual([110, 200]);
    expect(spanOf(result.value, 'a')).toEqual([108, 200]);
  });

  it('refuses whole when one half cannot follow, leaving the pair in step', () => {
    // A neighbour blocks the audio and not the video. A trim that went ahead on the picture alone is
    // precisely the reported bug, so the refusal has to leave *nothing* changed.
    const blocked = documentWith(
      [video('v', 100, 200, { linkedAudio: clipId('a') } as Partial<Clip>)],
      [audio('a', 100, 200, { linkedVideo: clipId('v') }), audio('later', 210, 300)],
    );
    const result = trimGroup({ document: blocked, clip: clipId('v'), edge: 'end', delta: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('collision');
  });

  it('leaves an unlinked clip to the ordinary single-clip path', () => {
    const lone = documentWith([video('v', 100, 200)], [audio('a', 100, 200)]);
    const result = trimGroup({ document: lone, clip: clipId('v'), edge: 'start', delta: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spanOf(result.value, 'v')).toEqual([120, 200]);
    expect(spanOf(result.value, 'a')).toEqual([100, 200]);
  });

  it('is a no-op at zero, so a drag that has not moved records no history', () => {
    const document = pair();
    const result = trimGroup({ document, clip: clipId('v'), edge: 'start', delta: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(document);
  });

  it('carries source bounds to the tail trim', () => {
    // 60 frames used from a 200-frame source leaves 40 of handle beyond the out-point.
    const sources: SourceBoundsResolver = { boundsFor: () => ({ totalFrames: 200 }) };
    const document = pair();
    expect(trimGroup({ document, clip: clipId('v'), edge: 'end', delta: 30, options: { sources } }).ok).toBe(
      true,
    );
    expect(trimGroup({ document, clip: clipId('v'), edge: 'end', delta: 60, options: { sources } }).ok).toBe(
      false,
    );
  });
});

describe('how far a trim can travel', () => {
  it('is the whole delta when nothing is in the way', () => {
    expect(reachableTrimDelta({ document: pair(), clip: clipId('v'), edge: 'end', delta: 40 })).toBe(40);
  });

  it('stops flush against what blocks the group rather than refusing the gesture', () => {
    // The audio's neighbour starts at 210, so the pair may grow by exactly ten frames — and a pair
    // that refused outright here would be harder to trim than a lone clip, which is the wrong way
    // round.
    const blocked = documentWith(
      [video('v', 100, 200, { linkedAudio: clipId('a') } as Partial<Clip>)],
      [audio('a', 100, 200, { linkedVideo: clipId('v') }), audio('later', 210, 300)],
    );
    const reachable = reachableTrimDelta({ document: blocked, clip: clipId('v'), edge: 'end', delta: 80 });
    expect(reachable).toBe(10);

    const applied = trimGroup({ document: blocked, clip: clipId('v'), edge: 'end', delta: reachable });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(spanOf(applied.value, 'a')).toEqual([100, 210]);
    expect(spanOf(applied.value, 'v')).toEqual([100, 210]);
  });

  it('reports nothing when even one frame is refused', () => {
    const blocked = documentWith(
      [video('v', 100, 200, { linkedAudio: clipId('a') } as Partial<Clip>)],
      [audio('a', 100, 200, { linkedVideo: clipId('v') }), audio('later', 200, 300)],
    );
    expect(reachableTrimDelta({ document: blocked, clip: clipId('v'), edge: 'end', delta: 50 })).toBe(0);
  });

  it('travels the negative direction too', () => {
    // A head trim backwards is limited by the material before the in-point: 60 frames of it.
    const reachable = reachableTrimDelta({ document: pair(), clip: clipId('v'), edge: 'start', delta: -90 });
    expect(reachable).toBe(-60);
  });
});
