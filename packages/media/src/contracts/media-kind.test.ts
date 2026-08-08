import { describe, expect, it } from 'vitest';
import {
  ASSET_TYPES,
  classifyAsset,
  extensionsForType,
  fileExtension,
  fileName,
  fileStem,
  isAssetType,
  isTimelineAsset,
  parentPath,
} from './media-kind.js';

describe('path helpers', () => {
  it('extracts the extension, lower-cased', () => {
    expect(fileExtension('media/interview_a.MP4')).toBe('mp4');
    expect(fileExtension('a/b/c.tar.gz')).toBe('gz');
  });

  it('reports no extension for a bare name', () => {
    expect(fileExtension('media/README')).toBeUndefined();
    expect(fileExtension('masks/m1')).toBeUndefined();
  });

  it('treats a leading dot as a hidden file, not an extension', () => {
    expect(fileExtension('.gitignore')).toBeUndefined();
    expect(fileExtension('notes/.hidden')).toBeUndefined();
  });

  it('extracts name, stem and parent', () => {
    expect(fileName('media/sub/broll_city.mov')).toBe('broll_city.mov');
    expect(fileStem('media/sub/broll_city.mov')).toBe('broll_city');
    expect(parentPath('media/sub/broll_city.mov')).toBe('media/sub');
    expect(parentPath('project.json')).toBe('');
  });

  it('keeps a dotless name intact as its own stem', () => {
    expect(fileStem('masks/m1')).toBe('m1');
  });
});

describe('classifyAsset', () => {
  it('classifies video containers', () => {
    for (const path of ['media/a.mp4', 'media/a.mov', 'media/a.mkv', 'media/a.webm']) {
      expect(classifyAsset(path)).toBe('video');
    }
  });

  it('classifies audio, including the lossless format generators must emit', () => {
    expect(classifyAsset('generated/bed_0031_seed881.flac')).toBe('audio');
    expect(classifyAsset('media/room_tone.wav')).toBe('audio');
  });

  it('classifies images', () => {
    expect(classifyAsset('media/frame.png')).toBe('image');
    expect(classifyAsset('media/plate.exr')).toBe('image');
  });

  it('classifies notes as text, so the browser can render markdown', () => {
    expect(classifyAsset('notes/treatment.md')).toBe('text');
    expect(classifyAsset('notes/vo_script.txt')).toBe('text');
  });

  it('returns undefined for an unknown type rather than guessing', () => {
    // The spec allows arbitrary files in the project folder; they are shown, not typed.
    expect(classifyAsset('notes/reference.psd')).toBeUndefined();
    expect(classifyAsset('README')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(classifyAsset('media/A.MOV')).toBe('video');
  });
});

describe('isTimelineAsset', () => {
  it('accepts what a track can hold', () => {
    expect(isTimelineAsset('media/a.mp4')).toBe(true);
    expect(isTimelineAsset('media/a.flac')).toBe(true);
    expect(isTimelineAsset('media/a.png')).toBe(true);
  });

  it('rejects notes and unknown files', () => {
    // A markdown note is a text *asset* but not something you drop on a track directly.
    expect(isTimelineAsset('notes/treatment.md')).toBe(false);
    expect(isTimelineAsset('notes/reference.psd')).toBe(false);
  });
});

describe('asset types', () => {
  it('exposes exactly the five types the spec fixes', () => {
    expect([...ASSET_TYPES]).toEqual(['video', 'audio', 'image', 'mask', 'text']);
  });

  it('guards the union at runtime', () => {
    expect(isAssetType('video')).toBe(true);
    expect(isAssetType('midi')).toBe(false);
  });

  it('lists extensions for a file filter, sorted', () => {
    const video = extensionsForType('video');
    expect(video).toContain('mp4');
    expect(video).toContain('mov');
    expect([...video]).toEqual([...video].sort());
  });

  it('reports no extensions for mask, which is produced not imported', () => {
    expect(extensionsForType('mask')).toEqual([]);
  });
});
