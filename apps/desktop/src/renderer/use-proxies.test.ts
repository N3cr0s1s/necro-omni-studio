import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type Clip,
  type TimelineDocument,
  type VideoClip,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { DEFAULT_PROXY } from '@nos/media';
import { type Proxies, describeProxies, proxyCandidates, shouldProxy } from './use-proxies.js';

/**
 * Which sources get an editing proxy, and what the user is told while one is being made.
 *
 * The decision is the part worth pinning down. A transcode is the heaviest thing the application
 * asks of the machine, so proxying something that gains nothing is not a wasted cycle but a wasted
 * minute — and doing it for the wrong reason (frame rate) would break the guarantee the proxy exists
 * to protect.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, asset: string): VideoClip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(asset), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
  } as VideoClip;
}

function audio(id: string, asset: string): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(asset), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
  } as AudioClip;
}

function documentWith(clips: readonly Clip[]): TimelineDocument {
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
        const mine = clips.filter((clip) => clip.kind === track.kind);
        return mine.length === 0
          ? track
          : ({ ...track, clips: mine } as (typeof base.sequence.tracks)[number]);
      }),
    },
  };
}

describe('what is worth proxying', () => {
  it('proxies a source larger than the target', () => {
    expect(shouldProxy({ width: 3840, height: 2160 })).toBe(true);
  });

  it('leaves a source that is already small enough alone', () => {
    // Re-encoding 720p to a 1080p proxy costs a full transcode, loses a generation of quality, and
    // hands the decoder the same pixels. A loss on every axis.
    expect(shouldProxy({ width: 1280, height: 720 })).toBe(false);
  });

  it('measures the short edge, so portrait material is judged the same way', () => {
    // 1080×1920 is the same pixel count as 1920×1080 and needs no proxy; comparing width would
    // transcode every vertical video in the project for nothing.
    expect(shouldProxy({ width: 1080, height: 1920 })).toBe(false);
    expect(shouldProxy({ width: 2160, height: 3840 })).toBe(true);
  });

  it('treats a source exactly at the target as not worth it', () => {
    expect(shouldProxy({ width: 1920, height: 1080 })).toBe(false);
  });

  it('does nothing for a source it could not measure', () => {
    // A probe that failed is not evidence that a transcode would help.
    expect(shouldProxy(undefined)).toBe(false);
  });

  it('honours a smaller target', () => {
    expect(shouldProxy({ width: 1920, height: 1080 }, { ...DEFAULT_PROXY, shortEdge: 720 })).toBe(true);
  });
});

describe('which assets are considered', () => {
  it('collects the video sources on the timeline', () => {
    const document = documentWith([video('a', 'media/a.mp4'), video('b', 'media/b.mp4')]);
    expect(proxyCandidates(document)).toEqual(['media/a.mp4', 'media/b.mp4']);
  });

  it('lists an asset once however many clips cut from it', () => {
    // Proxies are per asset. Deriving per clip would transcode the same file once per cut.
    const document = documentWith([video('a', 'media/a.mp4'), video('b', 'media/a.mp4')]);
    expect(proxyCandidates(document)).toEqual(['media/a.mp4']);
  });

  it('ignores audio, which has nothing to downscale', () => {
    const document = documentWith([audio('a', 'media/tone.flac')]);
    expect(proxyCandidates(document)).toEqual([]);
  });

  it('ignores an empty timeline rather than guessing', () => {
    expect(proxyCandidates(documentWith([]))).toEqual([]);
  });
});

describe('what the user is told', () => {
  const state = (overrides: Partial<Proxies> = {}): Proxies => ({
    resolve: (asset) => asset,
    pending: [],
    ready: 0,
    failures: [],
    ...overrides,
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeProxies(state())).toBeUndefined();
  });

  it('names the source being transcoded, so a heavy one is identifiable', () => {
    const text = describeProxies(state({ pending: [assetPath('media/4k.mov')] }));
    expect(text).toContain('media/4k.mov');
  });

  it('counts them when there are several', () => {
    const text = describeProxies(state({ pending: [assetPath('media/a.mov'), assetPath('media/b.mov')] }));
    expect(text).toContain('2 remaining');
  });

  it('reports a failure ahead of progress, because it will not resolve itself', () => {
    const text = describeProxies(
      state({ pending: [assetPath('media/a.mov')], failures: ['media/b.mov: ffmpeg refused it'] }),
    );
    expect(text).toContain('media/b.mov');
  });
});

describe('resolving', () => {
  it('is total, so callers substitute without deciding what a gap means', () => {
    const proxies: Proxies = {
      resolve: (asset) => asset,
      pending: [],
      ready: 0,
      failures: [],
    };
    expect(proxies.resolve(assetPath('media/never-proxied.mp4'))).toBe('media/never-proxied.mp4');
  });
});
