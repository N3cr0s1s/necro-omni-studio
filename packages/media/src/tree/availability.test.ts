import { describe, expect, it } from 'vitest';
import { assetPath, clipId, frameCount, frameIndex, frameSpan, trackId } from '@nos/core';
import type { AudioClip, TextClip, TimelineDocument, VideoClip } from '@nos/core';
import { type FileEntry, buildTree } from './folder-tree.js';
import { availabilityOf, describeAvailability, requiredAssets } from './availability.js';

/**
 * Which of a cut's material is actually on disk.
 *
 * A project is a folder, so its media can leave. The document keeps a project-relative path either
 * way — the right thing for it to keep — but nothing asked whether the path still resolves, so a clip
 * whose file had gone drew like any other, rendered as nothing, and said nothing.
 */

function file(path: string): FileEntry {
  return { path: assetPath(path), sizeBytes: 10, isDirectory: false };
}

function video(id: string, asset: string): VideoClip {
  return {
    id: clipId(id),
    kind: 'video',
    span: frameSpan(frameIndex(0), frameCount(30)),
    source: { asset: assetPath(asset), sourceIn: frameIndex(0), sourceRate: '30' },
    enabled: true,
    effects: [],
  } as unknown as VideoClip;
}

function audio(id: string, asset: string): AudioClip {
  return { ...video(id, asset), kind: 'audio' } as unknown as AudioClip;
}

function title(id: string): TextClip {
  return {
    id: clipId(id),
    kind: 'text',
    span: frameSpan(frameIndex(0), frameCount(30)),
    enabled: true,
    effects: [],
  } as unknown as TextClip;
}

function document(clips: readonly unknown[]): TimelineDocument {
  return {
    sequence: {
      id: 'main',
      tracks: [{ id: trackId('V1'), kind: 'video', name: 'V1', height: 84, clips }],
    },
  } as unknown as TimelineDocument;
}

describe('what a cut needs', () => {
  it('is every file its clips read, once each', () => {
    const assets = requiredAssets(
      document([video('a', 'media/one.mp4'), video('b', 'media/one.mp4'), audio('c', 'media/two.wav')]),
    );
    expect(assets).toEqual(['media/one.mp4', 'media/two.wav']);
  });

  it('does not include a title, which reads no file', () => {
    expect(requiredAssets(document([title('t')]))).toEqual([]);
  });

  it('is in first-use order, so the first thing named is the first thing seen', () => {
    const assets = requiredAssets(document([video('a', 'media/z.mp4'), video('b', 'media/a.mp4')]));
    expect(assets).toEqual(['media/z.mp4', 'media/a.mp4']);
  });
});

describe('against what the folder holds', () => {
  const cut = document([video('a', 'media/here.mp4'), video('b', 'media/gone.mp4'), title('t')]);
  const folder = buildTree([file('media/here.mp4')]);

  it('names the file that is not there', () => {
    expect(availabilityOf(cut, folder).missing).toEqual(['media/gone.mp4']);
  });

  it('marks the clips that cannot be drawn, and only those', () => {
    const availability = availabilityOf(cut, folder);
    expect(availability.offlineClips).toEqual(['b']);
    expect(availability.isOffline(clipId('a'))).toBe(false);
    expect(availability.isOffline(clipId('b'))).toBe(true);
  });

  it('marks every clip reading a missing file, not just the first', () => {
    const many = document([video('a', 'media/gone.mp4'), video('b', 'media/gone.mp4')]);
    expect(availabilityOf(many, buildTree([])).offlineClips).toEqual(['a', 'b']);
  });

  it('reports nothing missing when everything resolves', () => {
    const availability = availabilityOf(document([video('a', 'media/here.mp4')]), folder);
    expect(availability.missing).toEqual([]);
    expect(availability.offlineClips).toEqual([]);
  });

  it('reports everything present while the folder has not been read', () => {
    // A false alarm the second before the first scan lands is worse than saying nothing: it arrives
    // when the user is least able to judge it.
    expect(availabilityOf(cut, undefined).missing).toEqual([]);
    expect(availabilityOf(cut, undefined).isOffline(clipId('b'))).toBe(false);
  });
});

describe('saying so', () => {
  it('says nothing when nothing is missing', () => {
    expect(describeAvailability(availabilityOf(document([]), buildTree([])))).toBeUndefined();
  });

  it('names the file rather than counting clips', () => {
    // "3 clips are offline" sends the user hunting; the path tells them what to look for.
    const one = availabilityOf(document([video('a', 'media/gone.mp4')]), buildTree([]));
    expect(describeAvailability(one)).toBe('media/gone.mp4 is missing — its clips cannot be drawn');
  });

  it('names the first and counts the rest', () => {
    const two = availabilityOf(
      document([video('a', 'media/gone.mp4'), video('b', 'media/also.wav')]),
      buildTree([]),
    );
    expect(describeAvailability(two)).toBe(
      'media/gone.mp4 and 1 more are missing — their clips cannot be drawn',
    );
  });
});
