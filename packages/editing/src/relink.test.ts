import { describe, expect, it } from 'vitest';
import { assetPath, clipId, frameCount, frameIndex, frameSpan, trackId } from '@nos/core';
import type { AudioClip, TextClip, TimelineDocument, VideoClip } from '@nos/core';
import { clipsUsing, relinkAsset, relinkCandidates } from './relink.js';

/**
 * Pointing a cut at media that has moved.
 *
 * The editor can say a file has left the folder; until this, the only way to act on that was to close
 * the editor, put the file back under its old name, and reopen.
 */

function video(id: string, asset: string, sourceIn = 0): VideoClip {
  return {
    id: clipId(id),
    kind: 'video',
    span: frameSpan(frameIndex(0), frameCount(30)),
    source: { asset: assetPath(asset), sourceIn: frameIndex(sourceIn), sourceRate: '30' },
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

function document(video1: readonly unknown[], audio1: readonly unknown[] = []): TimelineDocument {
  return {
    sequence: {
      id: 'main',
      tracks: [
        { id: trackId('V1'), kind: 'video', name: 'V1', height: 84, clips: video1 },
        { id: trackId('A1'), kind: 'audio', name: 'A1', height: 64, clips: audio1 },
      ],
    },
  } as unknown as TimelineDocument;
}

describe('what a relink would touch', () => {
  it('is every clip reading the file, across tracks', () => {
    // The file moved once and the cut did not change, so a relink is about the asset rather than the
    // clip: fixing a bed used in nine places nine times would leave eight of them broken in between.
    const cut = document([video('a', 'media/bed.wav'), title('t')], [audio('b', 'media/bed.wav')]);
    expect(clipsUsing(cut, assetPath('media/bed.wav')).map((clip) => clip.id)).toEqual(['a', 'b']);
  });

  it('is nothing for a file no clip reads', () => {
    expect(clipsUsing(document([video('a', 'media/one.mp4')]), assetPath('media/two.mp4'))).toEqual([]);
  });
});

describe('rewriting the path', () => {
  const cut = document(
    [video('a', 'media/bed.wav'), video('c', 'media/other.mp4')],
    [audio('b', 'media/bed.wav')],
  );

  it('points every clip at the new file', () => {
    const next = relinkAsset(cut, assetPath('media/bed.wav'), assetPath('media/archive/bed.wav'));
    expect(clipsUsing(next, assetPath('media/archive/bed.wav')).map((clip) => clip.id)).toEqual(['a', 'b']);
    expect(clipsUsing(next, assetPath('media/bed.wav'))).toEqual([]);
  });

  it('rewrites every clip on a track, not just the first one it meets', () => {
    // The fixture above has one clip per track, so a rewrite that stopped after the first would still
    // look correct. Two on one track is what tells the difference.
    const twice = document([video('a', 'media/bed.wav'), video('b', 'media/bed.wav')]);
    const next = relinkAsset(twice, assetPath('media/bed.wav'), assetPath('media/archive/bed.wav'));
    expect(clipsUsing(next, assetPath('media/archive/bed.wav')).map((clip) => clip.id)).toEqual(['a', 'b']);
  });

  it('leaves clips reading something else alone', () => {
    const next = relinkAsset(cut, assetPath('media/bed.wav'), assetPath('media/archive/bed.wav'));
    expect(clipsUsing(next, assetPath('media/other.mp4')).map((clip) => clip.id)).toEqual(['c']);
  });

  it('changes only where the file is, never the edit', () => {
    // A user who moved a file into a subfolder has not asked for their trims back.
    const trimmed = document([video('a', 'media/bed.wav', 45)]);
    const next = relinkAsset(trimmed, assetPath('media/bed.wav'), assetPath('media/archive/bed.wav'));
    const clip = clipsUsing(next, assetPath('media/archive/bed.wav'))[0];
    expect(clip?.kind === 'video' ? clip.source.sourceIn : undefined).toBe(45);
  });

  it('returns the same document when nothing reads the old path', () => {
    // The store skips recording a no-op edit, which relies on identity rather than equality.
    expect(relinkAsset(cut, assetPath('media/absent.mp4'), assetPath('media/new.mp4'))).toBe(cut);
  });

  it('returns the same document when the two paths are the same', () => {
    expect(relinkAsset(cut, assetPath('media/bed.wav'), assetPath('media/bed.wav'))).toBe(cut);
  });
});

describe('guessing where it went', () => {
  const present = [
    assetPath('media/archive/bed.wav'),
    assetPath('renders/bed.wav'),
    assetPath('media/other.wav'),
  ];

  it('offers files of the same name, which is what survives a move', () => {
    const candidates = relinkCandidates(assetPath('media/bed.wav'), present);
    expect(candidates).toContain('media/archive/bed.wav');
    expect(candidates).not.toContain('media/other.wav');
  });

  it('offers the one that moved least first', () => {
    // A file moved one folder deep is far likelier than an unrelated file of the same name elsewhere.
    expect(relinkCandidates(assetPath('media/bed.wav'), present)[0]).toBe('media/archive/bed.wav');
  });

  it('never offers the missing file itself', () => {
    const candidates = relinkCandidates(assetPath('media/bed.wav'), [
      assetPath('media/bed.wav'),
      assetPath('media/archive/bed.wav'),
    ]);
    expect(candidates).toEqual(['media/archive/bed.wav']);
  });

  it('offers nothing rather than guessing when no name matches', () => {
    // A caller with no candidate still offers a chooser; the point is to save typing, not to decide.
    expect(relinkCandidates(assetPath('media/bed.wav'), [assetPath('media/other.wav')])).toEqual([]);
  });
});
