import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  type AudioTrack,
  type Clip,
  type Track,
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
import { eligibleTracksFor, limitedStart, trackForOffset } from './drag-target.js';

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, end: number): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(`media/${id}.mp4`), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
  } as Clip;
}

function audio(id: string, start: number, end: number): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath(`media/${id}.wav`), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
  } as AudioClip;
}

/** Three video tracks and two audio, all 60 px tall, in document order. */
function tracks(): readonly Track[] {
  const base = createDocument({
    id: projectId('p'),
    sequenceId: sequenceId('s'),
    name: 'p',
    frameRate: FRAME_RATES.WEB_30,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
  const v1 = base.sequence.tracks.find((track) => track.kind === 'video') as VideoTrack;
  const a1 = base.sequence.tracks.find((track) => track.kind === 'audio') as AudioTrack;

  return [
    { ...v1, id: trackId('v1'), height: 60 },
    { ...v1, id: trackId('v2'), name: 'V2', height: 60, clips: [] },
    { ...v1, id: trackId('v3'), name: 'V3', height: 60, clips: [] },
    { ...a1, id: trackId('a1'), height: 60 },
    { ...a1, id: trackId('a2'), name: 'A2', height: 60, clips: [] },
  ];
}

describe('which track a drag points at', () => {
  it('stays put for no vertical movement', () => {
    // The whole axis was ignored before this existed, on video and audio alike.
    const target = trackForOffset(tracks(), video('a', 0, 100), trackId('v1'), 0);
    expect(target).toEqual({ track: 'v1', kind: 'video', changed: false, deltaRows: 0 });
  });

  it('moves down a row once the pointer passes the halfway line', () => {
    const clip = video('a', 0, 100);
    expect(trackForOffset(tracks(), clip, trackId('v1'), 29)?.track).toBe('v1');
    expect(trackForOffset(tracks(), clip, trackId('v1'), 31)?.track).toBe('v2');
    expect(trackForOffset(tracks(), clip, trackId('v1'), 120)?.track).toBe('v3');
  });

  it('moves up as readily as down', () => {
    const clip = video('a', 0, 100);
    expect(trackForOffset(tracks(), clip, trackId('v3'), -60)?.track).toBe('v2');
    expect(trackForOffset(tracks(), clip, trackId('v3'), -120)?.track).toBe('v1');
  });

  it('skips the tracks that cannot hold the clip', () => {
    // A video dragged far down must not park on an audio row, and the distance an audio row would
    // have consumed must not be charged against reaching the next video row.
    const clip = video('a', 0, 100);
    expect(trackForOffset(tracks(), clip, trackId('v1'), 600)?.track).toBe('v3');
  });

  it('does the same for audio, which was equally stuck', () => {
    const clip = audio('m', 0, 100);
    expect(trackForOffset(tracks(), clip, trackId('a1'), 60)?.track).toBe('a2');
    expect(trackForOffset(tracks(), clip, trackId('a1'), -600)?.track).toBe('a1');
  });

  it('stops at the last eligible row rather than falling off the end', () => {
    const clip = video('a', 0, 100);
    expect(trackForOffset(tracks(), clip, trackId('v1'), 10_000)?.track).toBe('v3');
    expect(trackForOffset(tracks(), clip, trackId('v1'), -10_000)?.track).toBe('v1');
  });

  it('reports nothing when the clip is on no track it knows', () => {
    expect(trackForOffset(tracks(), video('a', 0, 100), trackId('gone'), 0)).toBeUndefined();
  });
});

describe('the row delta a group travels by', () => {
  // The number that keeps a linked pair together: a video moves down one video row and its audio down
  // one audio row, so neither can land where it cannot go and nothing has to be guessed.
  it('is signed and counted among the eligible rows', () => {
    const clip = video('a', 0, 100);
    expect(trackForOffset(tracks(), clip, trackId('v1'), 60)?.deltaRows).toBe(1);
    expect(trackForOffset(tracks(), clip, trackId('v3'), -60)?.deltaRows).toBe(-1);
    expect(trackForOffset(tracks(), clip, trackId('v1'), 120)?.deltaRows).toBe(2);
  });

  it('stops counting where the rows run out', () => {
    const clip = video('a', 0, 100);
    expect(trackForOffset(tracks(), clip, trackId('v1'), 10_000)?.deltaRows).toBe(2);
    expect(trackForOffset(tracks(), clip, trackId('v1'), -10_000)?.deltaRows).toBe(0);
  });

  it('lists only the tracks a clip may occupy', () => {
    expect(eligibleTracksFor(tracks(), video('a', 0, 100))).toEqual(['v1', 'v2', 'v3']);
    expect(eligibleTracksFor(tracks(), audio('m', 0, 100))).toEqual(['a1', 'a2']);
  });
});

describe('how far a blocked move can go', () => {
  const laden = (clips: readonly Clip[]): Track => ({ ...(tracks()[0] as VideoTrack), clips }) as Track;

  it('goes exactly where asked when nothing is in the way', () => {
    const track = laden([video('a', 300, 400)]);
    expect(
      limitedStart(track, [clipId('a')], spanFromBounds(frameIndex(300), frameIndex(400)), frameIndex(100)),
    ).toBe(100);
  });

  it('stops flush against the clip that blocks it, rather than refusing', () => {
    // The report: "I cannot drag a clip left even though there is room; if a clip blocks it, I
    // cannot pull it back at all." Refusing meant the whole gesture failed and the clip snapped back.
    const track = laden([video('block', 0, 200), video('a', 300, 400)]);
    const moved = limitedStart(
      track,
      [clipId('a')],
      spanFromBounds(frameIndex(300), frameIndex(400)),
      frameIndex(50),
    );
    expect(moved).toBe(200);
  });

  it('uses the room that exists when the wanted position is only partly blocked', () => {
    const track = laden([video('block', 0, 120), video('a', 300, 400)]);
    expect(
      limitedStart(track, [clipId('a')], spanFromBounds(frameIndex(300), frameIndex(400)), frameIndex(0)),
    ).toBe(120);
  });

  it('stops flush on the way right too', () => {
    const track = laden([video('a', 0, 100), video('block', 300, 400)]);
    // Asked for 350, which overlaps the block; the furthest it can go is flush against its start.
    expect(
      limitedStart(track, [clipId('a')], spanFromBounds(frameIndex(0), frameIndex(100)), frameIndex(350)),
    ).toBe(200);
  });

  it('passes over an obstacle to free space beyond it', () => {
    // Which is what dragging across a busy track means: the clip travels with the hand and lands
    // where there is room, rather than being stopped by everything it flies over.
    const track = laden([video('a', 0, 100), video('block', 300, 400)]);
    expect(
      limitedStart(track, [clipId('a')], spanFromBounds(frameIndex(0), frameIndex(100)), frameIndex(900)),
    ).toBe(900);
  });

  it('never jumps past the obstacle to a gap on the far side', () => {
    // A clip dragged left must not land to the *right* of where it started because a gap there
    // happened to be nearer in absolute terms — the hand was moving one way.
    const track = laden([video('block', 0, 350), video('a', 400, 500)]);
    const moved = limitedStart(
      track,
      [clipId('a')],
      spanFromBounds(frameIndex(400), frameIndex(500)),
      frameIndex(100),
    );
    expect(moved).toBe(350);
  });

  it('slides either way when the clip is arriving from another track', () => {
    // A vertical drag has no horizontal direction: the pointer moved down, and the clip's position on
    // the row it left says nothing about which way it should slide on the row it is joining. Without
    // this, dropping a clip onto an occupied row failed outright — the drag was refused and the clip
    // stayed where it was, which is what "I cannot move clips between tracks" looked like even after
    // the vertical axis started working.
    const track = laden([video('resident', 0, 90)]);
    const arriving = spanFromBounds(frameIndex(0), frameIndex(120));

    expect(limitedStart(track, [clipId('a')], arriving, frameIndex(0), { changingTrack: true })).toBe(90);
  });

  it('takes the nearer side when arriving between two clips', () => {
    const track = laden([video('left', 0, 100), video('right', 400, 500)]);
    const arriving = spanFromBounds(frameIndex(380), frameIndex(430));

    // Flush after `left` is 100; flush before `right` is 350. 350 is nearer to 380.
    expect(limitedStart(track, [clipId('a')], arriving, frameIndex(380), { changingTrack: true })).toBe(350);
  });

  it('keeps the directional rule for a move along one track', () => {
    // Unchanged by the cross-track case: a clip dragged left must not land to the right.
    const track = laden([video('block', 0, 350), video('a', 400, 500)]);
    expect(
      limitedStart(track, [clipId('a')], spanFromBounds(frameIndex(400), frameIndex(500)), frameIndex(100)),
    ).toBe(350);
  });

  it('leaves the clip where it is when it cannot move at all', () => {
    const track = laden([video('before', 0, 300), video('a', 300, 400)]);
    expect(
      limitedStart(track, [clipId('a')], spanFromBounds(frameIndex(300), frameIndex(400)), frameIndex(100)),
    ).toBe(300);
  });

  it('never goes before the start of the sequence', () => {
    const track = laden([video('a', 100, 200)]);
    expect(
      limitedStart(track, [clipId('a')], spanFromBounds(frameIndex(100), frameIndex(200)), frameIndex(-500)),
    ).toBe(0);
  });

  it('ignores the clips travelling with it', () => {
    // A selection moving together must not be blocked by its own members.
    const track = laden([video('a', 0, 100), video('b', 100, 200)]);
    expect(
      limitedStart(
        track,
        [clipId('a'), clipId('b')],
        spanFromBounds(frameIndex(100), frameIndex(200)),
        frameIndex(50),
      ),
    ).toBe(50);
  });

  it('drops onto an empty track wherever it was asked to', () => {
    expect(
      limitedStart(laden([]), [clipId('a')], spanFromBounds(frameIndex(0), frameIndex(100)), frameIndex(700)),
    ).toBe(700);
  });
});
