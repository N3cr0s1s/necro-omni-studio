import {
  AudioLinesIcon,
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  EyeIcon,
  EyeOffIcon,
  FilmIcon,
  LinkIcon,
  Link2OffIcon,
  PaintBucketIcon,
  PaletteIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BlendIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  PencilIcon,
  ScissorsIcon,
  SplitIcon,
  Trash2Icon,
  TypeIcon,
  UnplugIcon,
} from 'lucide-react';
import { shortcutLabel } from './shortcuts.js';
import { type ClipId, type TimelineDocument, type TrackId, linkedPartner, locateClip } from '@nos/core';
import { gapBefore } from '@nos/editing';
import type { ActionMenuItem } from '@nos/ui';

/**
 * What a right-click offers.
 *
 * Kept out of the component and out of the menu, because the answer depends on things neither knows:
 * what is selected, whether there is anything on the clipboard, whether this clip is linked. A menu
 * that offered every action unconditionally would be a list of mostly-disabled rows, and one that
 * offered only the enabled ones would change shape under the pointer.
 *
 * Every entry names its shortcut. A context menu that competed with the keyboard would keep users on
 * the mouse; one that shows the key teaches it.
 */

export interface ClipMenuState {
  readonly document: TimelineDocument;
  /** The clip under the pointer, absent for a right-click on empty timeline. */
  readonly clip: ClipId | undefined;
  /** The lane under the pointer, absent only below the last track. */
  readonly track?: TrackId | undefined;
  readonly selectionSize: number;
  readonly canPaste: boolean;
  readonly hasAttributes: boolean;
  /**
   * Whether the clicked clip's file is not in the project folder.
   *
   * Decided by the caller, which read the folder — the document cannot know. Offered only then, so
   * the menu never holds out a repair for something that is not broken.
   */
  readonly offline?: boolean;
  /** True when removing closes the gap, so the label can say which removal this is. */
  readonly ripple: boolean;
  /**
   * The crossfade the clicked cut would get, in frames, or absent when it cannot have one.
   *
   * Decided by the caller because it depends on how much material lies beyond each edge, which is
   * probe metadata rather than document state — the same reason `SourceBoundsResolver` is injected
   * into every trim.
   */
  readonly crossfadeFrames?: number | undefined;
  /**
   * Whether the clicked lane has a neighbour of its own kind to swap with.
   *
   * Decided by the caller, from the document, so the row and the action cannot disagree about
   * whether a move is possible.
   */
  readonly canMoveTrackUp?: boolean;
  readonly canMoveTrackDown?: boolean;
  /**
   * True when the selection is exactly one unlinked video and one unlinked audio clip.
   *
   * Decided by the caller because it is a question about the selection and the document, and computed
   * once so the menu row and the action cannot disagree about whether it is possible.
   */
  readonly canLink?: boolean;
}

export const CLIP_MENU_ACTIONS = [
  'add-video-track',
  'add-audio-track',
  'add-text-track',
  'rename-track',
  'collapse-track',
  'move-track-up',
  'move-track-down',
  'remove-track',
  'rename-clip',
  'relink',
  'cut',
  'copy',
  'paste',
  'duplicate',
  'split',
  'toggle-enabled',
  'unlink',
  'link',
  'copy-attributes',
  'paste-attributes',
  'close-gap',
  'close-track-gaps',
  'crossfade-at-cut',
  'remove',
] as const;

export type ClipMenuAction = (typeof CLIP_MENU_ACTIONS)[number];

export function clipMenuItems(state: ClipMenuState): readonly ActionMenuItem<ClipMenuAction>[] {
  const target = state.clip;
  const located = target === undefined ? undefined : locateClip(state.document, target);
  const linked = located === undefined ? false : linkedPartner(located.clip) !== undefined;
  const enabled = located?.clip.enabled ?? true;
  const nothing = state.selectionSize === 0 && target === undefined;
  const gap = target === undefined ? undefined : gapBefore(state.document, target);
  /*
   * How long a crossfade this cut could carry, or `undefined` for none at all.
   *
   * Decided by the caller, which knows how long the sources are — the document does not, and a menu
   * that offered a fade the material cannot supply would be a row that refuses when pressed.
   */
  const crossfade = state.crossfadeFrames;
  const track = state.track;
  // The last of its kind cannot go: a sequence with no video track has nowhere to drop a video, and
  // the user's next action after deleting it would be to create one.
  const laneClicked =
    track === undefined ? undefined : state.document.sequence.tracks.find((t) => t.id === track);
  const kind = laneClicked?.kind;
  // Read from the document rather than passed in: the label has to say which way this toggles, and a
  // caller that had to compute it could disagree with what the row is actually showing.
  const collapsed = laneClicked?.collapsed === true;
  const lastOfKind =
    kind === undefined || state.document.sequence.tracks.filter((t) => t.kind === kind).length <= 1;

  return [
    // Track actions first, because the report that prompted them was "I cannot create a track" from
    // someone who had right-clicked and found only clip actions. The toolbar's `+ V` buttons existed
    // and were not where anyone looked.
    { id: 'add-video-track', label: 'Add video track', icon: FilmIcon },
    { id: 'add-audio-track', label: 'Add audio track', icon: AudioLinesIcon },
    { id: 'add-text-track', label: 'Add text track', icon: TypeIcon },
    {
      id: 'rename-track',
      label: 'Rename track',
      icon: PencilIcon,
      disabled: track === undefined,
    },
    {
      // Reads as what the click will do, not as the state it is in: `Collapse track` on an expanded
      // one, `Expand track` on a collapsed one. A menu item labelled with the current state leaves the
      // user working out which way it toggles.
      id: 'collapse-track',
      label: collapsed ? 'Expand track' : 'Collapse track',
      icon: collapsed ? ChevronRightIcon : ChevronDownIcon,
      disabled: track === undefined,
    },
    {
      /*
       * Layer order, which the compositor reads: video tracks are walked in reverse so a later one
       * draws on top. Disabled at the ends of its own kind rather than hidden, because a control that
       * vanishes at the boundary leaves the user hunting for it.
       */
      id: 'move-track-up',
      label: 'Move track up',
      icon: ArrowUpIcon,
      disabled: track === undefined || !state.canMoveTrackUp,
      separated: true,
    },
    {
      id: 'move-track-down',
      label: 'Move track down',
      icon: ArrowDownIcon,
      disabled: track === undefined || !state.canMoveTrackDown,
    },
    {
      id: 'remove-track',
      label: 'Delete track',
      icon: Trash2Icon,
      disabled: track === undefined || lastOfKind,
      danger: true,
    },

    {
      // Named for what it renames, because this menu also offers `Rename track` and the two are one
      // click apart. A clip and the row it sits on are different things to name.
      id: 'rename-clip',
      label: 'Rename clip',
      icon: PencilIcon,
      disabled: nothing,
      separated: true,
    },

    /*
     * Only when the clip is actually offline. A relink offered on healthy media is an invitation to
     * repoint a clip by accident, and the action is a whole-project rewrite: every clip reading that
     * file follows it.
     */
    ...(state.offline === true
      ? [
          {
            id: 'relink' as const,
            label: 'Relink media…',
            icon: UnplugIcon,
            disabled: nothing,
            separated: true,
          },
        ]
      : []),

    { id: 'cut', label: 'Cut', icon: ScissorsIcon, shortcut: shortcutLabel('cut'), disabled: nothing },
    { id: 'copy', label: 'Copy', icon: CopyIcon, shortcut: shortcutLabel('copy'), disabled: nothing },
    {
      id: 'paste',
      label: 'Paste',
      icon: ClipboardPasteIcon,
      shortcut: shortcutLabel('paste'),
      disabled: !state.canPaste,
    },
    {
      id: 'duplicate',
      label: 'Duplicate',
      icon: CopyPlusIcon,
      shortcut: shortcutLabel('duplicate'),
      disabled: nothing,
    },

    {
      id: 'split',
      label: 'Split at playhead',
      icon: SplitIcon,
      shortcut: shortcutLabel('split'),
      disabled: nothing,
      separated: true,
    },
    {
      // Named for the state it produces rather than the verb, so the row says what will happen to
      // the clip the user is looking at.
      id: 'toggle-enabled',
      label: enabled ? 'Disable' : 'Enable',
      icon: enabled ? EyeOffIcon : EyeIcon,
      shortcut: shortcutLabel('toggle-enabled'),
      disabled: nothing,
    },
    {
      id: 'unlink',
      label: 'Unlink audio and video',
      icon: Link2OffIcon,
      // Offered only on a linked clip: on anything else it would be a permanently dead row teaching
      // the user that this menu is mostly furniture.
      disabled: !linked,
    },
    {
      // The other half of unlinking, which had no way back. `linkClips` existed, tested, with no
      // caller — so splitting a pair was a one-way door, and the only recovery was undo.
      id: 'link',
      label: 'Link audio and video',
      icon: LinkIcon,
      disabled: !state.canLink,
    },

    {
      id: 'copy-attributes',
      label: 'Copy look',
      icon: PaletteIcon,
      shortcut: shortcutLabel('copy-attributes'),
      disabled: target === undefined,
      separated: true,
    },
    {
      id: 'paste-attributes',
      label: 'Paste look',
      icon: PaintBucketIcon,
      shortcut: shortcutLabel('paste-attributes'),
      disabled: !state.hasAttributes || nothing,
    },

    /*
     * Closing a gap, per issue #38's third complaint: "there is one frame of blackness, because for
     * some reason I cannot place the videos exactly next to each other".
     *
     * The row states how many frames it would close, because a gap of one frame is invisible at every
     * zoom a person works at — a command offering to remove something the user cannot see has to say
     * what it found. Offered only when there is one, from the same function the action calls, so a row
     * that is enabled cannot then do nothing.
     */
    /*
     * A crossfade at the cut, per issue #38 — the half that keeps the sequence's length.
     *
     * Dropping a clip onto its neighbour is the other half and makes the cut shorter by the overlap.
     * Both are wanted, and which one a person means is decided by whether the cut is already timed.
     *
     * The row states the length it would make, so a cut with little material to spare offers a short
     * fade rather than a refusal — "there is not enough" is true and unhelpful next to "six frames is
     * all this cut has".
     */
    {
      id: 'crossfade-at-cut',
      label: crossfade === undefined ? 'Crossfade at the cut' : `Crossfade at the cut (${crossfade} f)`,
      icon: BlendIcon,
      shortcut: shortcutLabel('crossfade-at-cut'),
      disabled: crossfade === undefined,
      separated: true,
    },

    {
      id: 'close-gap',
      label: gap === undefined ? 'Close the gap' : `Close the gap (${gap.frames} f)`,
      icon: ChevronsLeftIcon,
      shortcut: shortcutLabel('close-gap'),
      disabled: gap === undefined,
      separated: true,
    },
    {
      id: 'close-track-gaps',
      label: 'Close every gap on this track',
      icon: ChevronsLeftIcon,
      disabled: laneClicked === undefined || laneClicked.locked,
    },

    {
      id: 'remove',
      label: state.ripple ? 'Ripple delete' : 'Delete',
      icon: Trash2Icon,
      shortcut: shortcutLabel('remove'),
      disabled: nothing,
      separated: true,
      danger: true,
    },
  ];
}
