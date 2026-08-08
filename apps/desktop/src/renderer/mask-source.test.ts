import { describe, expect, it } from 'vitest';
import {
  type Clip,
  type TimelineDocument,
  type VideoTrack,
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
import { type MaskFrame, applyEvent, beginRun, beginSession, emptyTrack, maskTrackId } from '@nos/masks';
import { clipStartOf, maskIdForClip, sessionMaskSource } from './mask-source.js';

/**
 * Resolving a bound mask to the frame being drawn.
 *
 * The link that was missing from M11: everything else worked — the segmenter produced masks, an effect
 * could name one, the plan carried the id, the compositor asked for a texture — and the renderer
 * answered `undefined` every time, so a bound mask drew nothing at all.
 *
 * The conversion is the part worth pinning down. Session frames are **clip-relative** and the render is
 * asked for an **absolute** timeline frame; getting that wrong shows up as a mask that is simply on the
 * wrong part of the shot, which looks like a segmentation failure rather than an arithmetic one.
 */

const range = spanFromBounds(frameIndex(0), frameIndex(90));

function clip(start: number): Clip {
  return {
    kind: 'video',
    id: clipId('c1'),
    span: spanFromBounds(frameIndex(start), frameIndex(start + 90)),
    label: 'take.mp4',
    enabled: true,
    effects: [],
    source: {
      asset: assetPath('media/take.mp4'),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.WEB_30,
    },
    transform: {
      x: staticNumber(0),
      y: staticNumber(0),
      scale: staticNumber(1),
      rotation: staticNumber(0),
      opacity: staticNumber(1),
    },
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

function documentWith(start: number): TimelineDocument {
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
      tracks: base.sequence.tracks.map((track) =>
        track.kind === 'video' ? ({ ...track, clips: [clip(start)] } as VideoTrack) : track,
      ),
    },
  };
}

const mask = (frame: number): MaskFrame => ({
  frame: frameIndex(frame),
  width: 2,
  height: 2,
  counts: [0, 4],
});

/** A session holding one mask at clip-relative frame 10. */
function sessionWithMask() {
  const track = emptyTrack(maskTrackId('c1-mask'), clipId('c1'), range);
  return applyEvent(beginRun(beginSession(track, frameIndex(10))), { kind: 'frame', mask: mask(10) });
}

describe('the id an effect stores', () => {
  it('is derived from the clip, so it survives a save', () => {
    // The session that produced the mask is gone by the next launch; a generated id would leave the
    // effect pointing at nothing.
    expect(maskIdForClip('c1')).toBe('c1-mask');
    expect(maskIdForClip('c1')).toBe(maskIdForClip('c1'));
  });
});

describe('finding the frame', () => {
  it('converts a timeline frame to the clip-relative one the session holds', () => {
    // The whole point: a mask propagated over frames 0–90 of a clip that starts at 500 has to be found
    // at 500–590 while rendering.
    const source = sessionMaskSource(sessionWithMask(), 500);
    expect(source.at(510)[0]?.frame).toEqual(mask(10));
  });

  it('reports the binding with no frame where the mask has no coverage', () => {
    // Not an omission: the registration says the id is bound and simply has nothing here, which is
    // what releases the sampler rather than leaving the previous frame's mask on screen.
    const source = sessionMaskSource(sessionWithMask(), 500);
    const registration = source.at(700)[0];
    expect(registration?.id).toBe('c1-mask');
    expect(registration?.frame).toBeUndefined();
  });

  it('finds nothing before the clip starts, rather than reading a negative frame', () => {
    const source = sessionMaskSource(sessionWithMask(), 500);
    expect(source.at(100)[0]?.frame).toBeUndefined();
  });

  it('binds nothing at all with no session', () => {
    expect(sessionMaskSource(undefined, 0).at(10)).toEqual([]);
  });
});

describe('where a clip starts', () => {
  it('is the clip´s own position, which is what the conversion needs', () => {
    expect(clipStartOf(documentWith(500), 'c1')).toBe(500);
  });

  it('is zero for no selection, so nothing resolves rather than the wrong thing', () => {
    expect(clipStartOf(documentWith(500), undefined)).toBe(0);
  });

  it('is zero for a clip that is gone, which a stale selection produces', () => {
    expect(clipStartOf(documentWith(500), 'nope')).toBe(0);
  });
});
