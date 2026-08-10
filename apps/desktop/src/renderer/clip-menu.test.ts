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
  frameIndex,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import type { ActionMenuItem } from '@nos/ui';
import { CLIP_MENU_ACTIONS, type ClipMenuState, clipMenuItems } from './clip-menu.js';

/**
 * What a right-click offers.
 *
 * A value rather than a rendered thing, which is the point of keeping it here: what the menu shows
 * depends on the selection, the clipboard and whether the clip is linked, and all three are worth
 * pinning down without rendering anything.
 */

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

function audio(id: string, extra: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: 'audio',
    id: clipId(id),
    span: spanFromBounds(frameIndex(0), frameIndex(100)),
    label: id,
    enabled: true,
    effects: [],
    source: { asset: assetPath('media/a.mp4'), sourceIn: frameIndex(0), sourceRate: FRAME_RATES.WEB_30 },
    speed: { factor: 1, preservePitch: true },
    gain: staticNumber(1),
    pan: staticNumber(0),
    ...extra,
  } as AudioClip;
}

function documentWith(clips: readonly Clip[], audioClips: readonly AudioClip[] = []): TimelineDocument {
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

function state(overrides: Partial<ClipMenuState> = {}): ClipMenuState {
  return {
    document: documentWith([video('a')]),
    clip: clipId('a'),
    selectionSize: 1,
    canPaste: false,
    hasAttributes: false,
    ripple: false,
    ...overrides,
  };
}

const item = (items: readonly ActionMenuItem[], id: string) => items.find((entry) => entry.id === id);

describe('what is offered', () => {
  it('offers the editing verbs on a clip', () => {
    const items = clipMenuItems(state());
    expect(items.map((entry) => entry.id)).toContain('split');
    expect(item(items, 'split')?.disabled).toBe(false);
  });

  it('names its shortcut, so the menu teaches rather than competes', () => {
    const items = clipMenuItems(state());
    expect(item(items, 'copy')?.shortcut).toBe('Ctrl+C');
  });

  it('disables everything that needs a selection when there is none', () => {
    const items = clipMenuItems(state({ clip: undefined, selectionSize: 0 }));
    expect(item(items, 'cut')?.disabled).toBe(true);
    expect(item(items, 'remove')?.disabled).toBe(true);
  });

  it('still offers paste on empty timeline, which is the point of right-clicking it', () => {
    const items = clipMenuItems(state({ clip: undefined, selectionSize: 0, canPaste: true }));
    expect(item(items, 'paste')?.disabled).toBe(false);
  });

  it('offers nothing to paste when the clipboard is empty', () => {
    expect(item(clipMenuItems(state()), 'paste')?.disabled).toBe(true);
  });
});

describe('the label says what will happen', () => {
  it('offers to disable an enabled clip', () => {
    expect(item(clipMenuItems(state()), 'toggle-enabled')?.label).toBe('Disable');
  });

  it('offers to enable a disabled one', () => {
    const document = documentWith([video('a', { enabled: false })]);
    expect(item(clipMenuItems(state({ document })), 'toggle-enabled')?.label).toBe('Enable');
  });

  it('names the removal the ripple mode will actually perform', () => {
    expect(item(clipMenuItems(state({ ripple: true })), 'remove')?.label).toBe('Ripple delete');
    expect(item(clipMenuItems(state({ ripple: false })), 'remove')?.label).toBe('Delete');
  });

  it('marks the removal as destructive', () => {
    // Undo is a worse answer than not doing it.
    expect(item(clipMenuItems(state()), 'remove')?.danger).toBe(true);
  });
});

describe('unlinking', () => {
  const linkedDocument = () =>
    documentWith(
      [video('v', { linkedAudio: clipId('m') } as Partial<Clip>)],
      [audio('m', { linkedVideo: clipId('v') })],
    );

  it('is offered on a linked clip', () => {
    const items = clipMenuItems(state({ document: linkedDocument(), clip: clipId('v') }));
    expect(item(items, 'unlink')?.disabled).toBe(false);
  });

  it('is offered from the audio half too', () => {
    const items = clipMenuItems(state({ document: linkedDocument(), clip: clipId('m') }));
    expect(item(items, 'unlink')?.disabled).toBe(false);
  });

  it('is dead on a clip with no partner, rather than absent', () => {
    // A row that appears and disappears makes the menu change shape under the pointer; a disabled one
    // says the action exists and does not apply here.
    expect(item(clipMenuItems(state()), 'unlink')?.disabled).toBe(true);
  });
});

describe('the look', () => {
  it('can be copied from the clicked clip', () => {
    expect(item(clipMenuItems(state()), 'copy-attributes')?.disabled).toBe(false);
  });

  it('cannot be pasted before one has been copied', () => {
    expect(item(clipMenuItems(state()), 'paste-attributes')?.disabled).toBe(true);
  });

  it('can be pasted once one has', () => {
    expect(item(clipMenuItems(state({ hasAttributes: true })), 'paste-attributes')?.disabled).toBe(false);
  });
});

describe('track actions', () => {
  // The report was "I cannot create a track": the toolbar's `+ V` buttons existed and were not where
  // anyone looked, and a right-click offered clip actions only.
  it('offers a track of each kind, always', () => {
    const items = clipMenuItems(state({ clip: undefined, selectionSize: 0, track: undefined }));
    for (const id of ['add-video-track', 'add-audio-track', 'add-text-track']) {
      expect(item(items, id)?.disabled).toBeFalsy();
    }
  });

  it('renames and deletes the lane that was clicked', () => {
    const items = clipMenuItems(state({ track: trackId('v1') }));
    expect(item(items, 'rename-track')?.disabled).toBeFalsy();
  });

  it('offers to rename the clip that was clicked, separately from its lane', () => {
    // Both are in this menu, one click apart. A clip and the row it sits on are different things to
    // name, and the generated ones arrive sharing a name with every sibling variant.
    const items = clipMenuItems(state({ clip: clipId('c1'), track: trackId('v1') }));
    expect(item(items, 'rename-clip')?.disabled).toBeFalsy();
    expect(item(items, 'rename-clip')?.label).toBe('Rename clip');
    expect(item(items, 'rename-track')?.label).toBe('Rename track');
  });

  it('says what collapsing will do, not what state the lane is in', () => {
    // `Collapse track` on an open one and `Expand track` on a collapsed one. An item labelled with the
    // current state leaves the user working out which way it toggles.
    const open = clipMenuItems(state({ track: trackId('v1') }));
    expect(item(open, 'collapse-track')?.label).toBe('Collapse track');

    const open2 = documentWith([video('a')]);
    const document: TimelineDocument = {
      ...open2,
      sequence: {
        ...open2.sequence,
        tracks: open2.sequence.tracks.map((track) =>
          track.id === 'v1' ? ({ ...track, collapsed: true } as Track) : track,
        ),
      },
    };
    const shut = clipMenuItems(state({ document, track: trackId('v1') }));
    expect(item(shut, 'collapse-track')?.label).toBe('Expand track');
  });

  it('cannot collapse when the click was on no lane', () => {
    expect(item(clipMenuItems(state({ track: undefined })), 'collapse-track')?.disabled).toBe(true);
  });

  it('cannot rename a clip when the click was on no clip', () => {
    // An empty lane. Renaming would have to pick a clip the user did not click.
    const items = clipMenuItems(state({ clip: undefined, selectionSize: 0, track: trackId('v1') }));
    expect(item(items, 'rename-clip')?.disabled).toBe(true);
  });

  it('cannot rename or delete when the click was on no lane at all', () => {
    // Below the last track. Offering it would act on some other track, which is the one thing a
    // context menu must never do.
    const items = clipMenuItems(state({ track: undefined }));
    expect(item(items, 'rename-track')?.disabled).toBe(true);
    expect(item(items, 'remove-track')?.disabled).toBe(true);
  });

  it('refuses to delete the last track of its kind', () => {
    // A sequence with no video track has nowhere to drop a video, and the user's next action after
    // deleting it would be to create one.
    expect(item(clipMenuItems(state({ track: trackId('v1') })), 'remove-track')?.disabled).toBe(true);
  });

  it('allows deleting a track once another of its kind exists', () => {
    const twoVideo = documentWith([video('a')]);
    const extended: TimelineDocument = {
      ...twoVideo,
      sequence: {
        ...twoVideo.sequence,
        tracks: [
          ...twoVideo.sequence.tracks,
          { ...(twoVideo.sequence.tracks[0] as Track), id: trackId('v2'), name: 'V2' },
        ],
      },
    };
    const items = clipMenuItems(state({ document: extended, track: trackId('v2') }));
    expect(item(items, 'remove-track')?.disabled).toBe(false);
  });

  it('marks deleting a track as destructive', () => {
    expect(item(clipMenuItems(state({ track: trackId('v1') })), 'remove-track')?.danger).toBe(true);
  });
});

describe('linking', () => {
  it('is offered when the caller says the selection can be linked', () => {
    expect(item(clipMenuItems(state({ canLink: true })), 'link')?.disabled).toBe(false);
  });

  it('is disabled otherwise, rather than hidden', () => {
    // The rows stay put whatever the state; a menu that changed shape under the pointer would be
    // harder to use than one with a greyed row.
    expect(item(clipMenuItems(state()), 'link')?.disabled).toBe(true);
  });

  it('sits beside unlinking, since they are the same decision either way', () => {
    const ids = clipMenuItems(state()).map((entry) => entry.id);
    expect(ids.indexOf('link')).toBe(ids.indexOf('unlink') + 1);
  });
});

describe('shape', () => {
  it('keeps the same rows whatever the state, so the menu does not move under the pointer', () => {
    const full = clipMenuItems(state({ canPaste: true, hasAttributes: true })).map((entry) => entry.id);
    const empty = clipMenuItems(state({ clip: undefined, selectionSize: 0 })).map((entry) => entry.id);

    expect(empty).toEqual(full);
  });

  it('separates the destructive action from the rest', () => {
    expect(item(clipMenuItems(state()), 'remove')?.separated).toBe(true);
  });
});

/**
 * Closing a gap.
 *
 * A gap of one frame is invisible at every zoom a person works at and unmistakable in the delivered
 * file, so the row has to say what it found — a command offering to remove something the user cannot
 * see is otherwise indistinguishable from one that does nothing.
 */
describe('closing a gap', () => {
  const withGap = () =>
    documentWith([
      video('a', { span: spanFromBounds(frameIndex(0), frameIndex(100)) }),
      video('b', { span: spanFromBounds(frameIndex(101), frameIndex(200)) }),
    ]);

  it('states how many frames it would close', () => {
    const items = clipMenuItems(state({ document: withGap(), clip: clipId('b') }));
    expect(item(items, 'close-gap')?.label).toBe('Close the gap (1 f)');
    expect(item(items, 'close-gap')?.disabled).toBe(false);
  });

  it('is offered disabled when the clips already meet, rather than vanishing', () => {
    const items = clipMenuItems(state({ clip: clipId('a') }));
    expect(item(items, 'close-gap')?.disabled).toBe(true);
    expect(item(items, 'close-gap')?.label).toBe('Close the gap');
  });

  it('offers the whole track only where a lane was clicked', () => {
    const onLane = clipMenuItems(state({ document: withGap(), clip: clipId('b'), track: trackId('v1') }));
    expect(item(onLane, 'close-track-gaps')?.disabled).toBe(false);

    const offLane = clipMenuItems(state({ document: withGap(), clip: clipId('b') }));
    expect(item(offLane, 'close-track-gaps')?.disabled).toBe(true);
  });
});

/**
 * A crossfade at the cut.
 *
 * The half of #38 that keeps the sequence's length. The row states the length it would make, because
 * a cut with little material to spare should offer a short fade rather than a refusal.
 */
describe('crossfading at a cut', () => {
  it('states the length it would make', () => {
    const items = clipMenuItems(state({ crossfadeFrames: 15 }));
    expect(item(items, 'crossfade-at-cut')?.label).toBe('Crossfade at the cut (15 f)');
    expect(item(items, 'crossfade-at-cut')?.disabled).toBe(false);
  });

  it('is offered disabled where the cut cannot carry one, rather than vanishing', () => {
    // A row that disappears is one the user cannot learn exists; a disabled one says the gesture is
    // real and this cut is not ready for it.
    const items = clipMenuItems(state());
    expect(item(items, 'crossfade-at-cut')?.disabled).toBe(true);
    expect(item(items, 'crossfade-at-cut')?.label).toBe('Crossfade at the cut');
  });

  it('carries its shortcut, since this is a keyboard gesture first', () => {
    expect(item(clipMenuItems(state({ crossfadeFrames: 15 })), 'crossfade-at-cut')?.shortcut).toBeDefined();
  });
});

/*
 * Both halves of the menu's vocabulary, checked against each other.
 *
 * The list of actions and the rows that offer them are separate declarations, and the switch that
 * runs a choice is a third. Two of the three are now held together by the type — a row whose id is
 * not in the union no longer compiles, and the switch is exhaustive over the union — but nothing
 * says a *declared* action is ever actually offered.
 *
 * That direction matters less at runtime and more when reading: a member no row emits is a case in
 * the switch that can never run, and the next person to touch it has to work out from scratch
 * whether it is dead or whether the row that offered it was lost in an edit.
 */
describe('the vocabulary', () => {
  const everyOffered = new Set(
    [
      // A right-click on a clip, on a lane, and on empty timeline: between them these reach every
      // row the menu has, including the ones that appear only when the caller supplies a reason.
      state({ offline: true, crossfadeFrames: 12, canLink: true, canMoveTrackUp: true }),
      state({ track: trackId('v1') }),
      state({ clip: undefined, selectionSize: 0 }),
    ].flatMap((each) => clipMenuItems(each).map((entry) => entry.id)),
  );

  it.each(CLIP_MENU_ACTIONS)('offers %s somewhere', (action) => {
    expect(everyOffered.has(action)).toBe(true);
  });

  it('offers nothing it has not declared', () => {
    // The compiler already refuses an unknown id at the row. Asserted anyway, because the type is
    // only as good as the annotation on `clipMenuItems`, and an annotation is one edit from gone.
    const declared = new Set<string>(CLIP_MENU_ACTIONS);
    expect([...everyOffered].filter((id) => !declared.has(id))).toEqual([]);
  });
});
