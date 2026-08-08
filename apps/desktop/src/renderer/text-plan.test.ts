import { describe, expect, it } from 'vitest';
import {
  type TextClip,
  type TimelineDocument,
  type Track,
  FRAME_RATES,
  clipId,
  createDocument,
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { contentCacheKey } from '@nos/text';
import { textCacheKeyFor, textClipsOf, textMaxWidth } from './text-plan.js';

/**
 * The bridge between text clips and the render plan.
 *
 * The property under test is that **one definition** computes the key. The plan carries a cache key
 * rather than a font, which is what keeps the compositor ignorant of typography — and it means a
 * mismatch between the key the plan asks for and the key the rasterizer stored under would produce a
 * title that never appears, with nothing reported. Expressing it once makes that unrepresentable.
 */

const TRACKS = { video: trackId('V1'), audio: trackId('A1'), text: trackId('T1') };

const content: TextClip['content'] = {
  text: 'Title',
  font: 'system-ui',
  size: 72,
  weight: 700,
  color: { r: 1, g: 1, b: 1, a: 1 },
  align: 'center',
  lineHeight: 1.2,
  letterSpacing: 0,
};

function textClip(id: string, overrides: Partial<TextClip> = {}): TextClip {
  return {
    kind: 'text',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(90)),
    label: id,
    enabled: true,
    effects: [],
    content,
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    ...overrides,
  };
}

function documentWith(clips: readonly TextClip[]): TimelineDocument {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'P',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: TRACKS,
  });
  return {
    ...base,
    sequence: {
      ...base.sequence,
      tracks: base.sequence.tracks.map((track) =>
        track.kind === 'text' ? ({ ...track, clips } as Track) : track,
      ),
    },
  };
}

describe('the wrapping width', () => {
  it('leaves a margin, so a full-width line is not flush to the frame edge', () => {
    expect(textMaxWidth({ width: 1000, height: 500 })).toBe(900);
  });

  it('stays usable at any resolution', () => {
    // A proxy-sized preview must still be able to lay out a title rather than wrapping every word.
    expect(textMaxWidth({ width: 8, height: 8 })).toBeGreaterThanOrEqual(16);
  });
});

describe('collecting text clips', () => {
  it('finds them on the text track', () => {
    const document = documentWith([textClip('t1'), textClip('t2')]);
    expect(textClipsOf(document).map((clip) => clip.id)).toEqual(['t1', 't2']);
  });

  it('returns none for a document with no titles', () => {
    expect(textClipsOf(documentWith([]))).toEqual([]);
  });
});

describe('the cache key', () => {
  it('is the same one the rasterizer stores under', () => {
    // The whole point of this module. Two computations of this key would eventually disagree, and the
    // symptom would be a title that renders nowhere with nothing reported.
    const resolution = { width: 1920, height: 1080 };
    const clip = textClip('t1');

    expect(textCacheKeyFor(resolution)(clip)).toBe(contentCacheKey(clip.content, textMaxWidth(resolution)));
  });

  it('changes when the pixels would change', () => {
    const resolution = { width: 1920, height: 1080 };
    const key = textCacheKeyFor(resolution);

    expect(key(textClip('t1'))).not.toBe(key(textClip('t1', { content: { ...content, text: 'Different' } })));
    expect(key(textClip('t1'))).not.toBe(key(textClip('t1', { content: { ...content, size: 96 } })));
  });

  it('does not change when only the position does', () => {
    // The spec's rule: an animated title rasterizes once for its whole duration. A key that moved with
    // the transform would re-rasterize every frame of a slide.
    const key = textCacheKeyFor({ width: 1920, height: 1080 });
    const moved = textClip('t1', {
      transform: {
        x: staticNumber(0.3),
        y: staticNumber(-0.2),
        scale: staticNumber(1.4),
        rotation: staticNumber(12),
        opacity: staticNumber(0.5),
      },
    });

    expect(key(moved)).toBe(key(textClip('t1')));
  });

  it('does not change when only the clip id does', () => {
    // Two clips with identical styling share one texture — the common case for a lower third that
    // repeats through a piece.
    const key = textCacheKeyFor({ width: 1920, height: 1080 });
    expect(key(textClip('t1'))).toBe(key(textClip('t2')));
  });

  it('changes with the resolution, because that changes where the text wraps', () => {
    const wide = textCacheKeyFor({ width: 3840, height: 2160 })(textClip('t1'));
    const narrow = textCacheKeyFor({ width: 640, height: 360 })(textClip('t1'));
    expect(wide).not.toBe(narrow);
  });
});
