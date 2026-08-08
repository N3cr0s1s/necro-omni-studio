import { type ClipId, type TimelineDocument, type TrackId, linkedPartner, locateClip } from '@nos/core';
import type { ContextMenuItem } from '@nos/ui';

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
  /** True when removing closes the gap, so the label can say which removal this is. */
  readonly ripple: boolean;
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
  'remove-track',
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
  'remove',
] as const;

export type ClipMenuAction = (typeof CLIP_MENU_ACTIONS)[number];

export function clipMenuItems(state: ClipMenuState): readonly ContextMenuItem[] {
  const target = state.clip;
  const located = target === undefined ? undefined : locateClip(state.document, target);
  const linked = located === undefined ? false : linkedPartner(located.clip) !== undefined;
  const enabled = located?.clip.enabled ?? true;
  const nothing = state.selectionSize === 0 && target === undefined;
  const track = state.track;
  // The last of its kind cannot go: a sequence with no video track has nowhere to drop a video, and
  // the user's next action after deleting it would be to create one.
  const kind =
    track === undefined ? undefined : state.document.sequence.tracks.find((t) => t.id === track)?.kind;
  const lastOfKind =
    kind === undefined || state.document.sequence.tracks.filter((t) => t.kind === kind).length <= 1;

  return [
    // Track actions first, because the report that prompted them was "I cannot create a track" from
    // someone who had right-clicked and found only clip actions. The toolbar's `+ V` buttons existed
    // and were not where anyone looked.
    { id: 'add-video-track', label: 'Add video track' },
    { id: 'add-audio-track', label: 'Add audio track' },
    { id: 'add-text-track', label: 'Add text track' },
    {
      id: 'rename-track',
      label: 'Rename track',
      disabled: track === undefined,
    },
    {
      id: 'remove-track',
      label: 'Delete track',
      disabled: track === undefined || lastOfKind,
      danger: true,
    },

    { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X', disabled: nothing, separated: true },
    { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', disabled: nothing },
    { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: !state.canPaste },
    { id: 'duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', disabled: nothing },

    { id: 'split', label: 'Split at playhead', shortcut: 'S', disabled: nothing, separated: true },
    {
      // Named for the state it produces rather than the verb, so the row says what will happen to
      // the clip the user is looking at.
      id: 'toggle-enabled',
      label: enabled ? 'Disable' : 'Enable',
      shortcut: 'E',
      disabled: nothing,
    },
    {
      id: 'unlink',
      label: 'Unlink audio and video',
      // Offered only on a linked clip: on anything else it would be a permanently dead row teaching
      // the user that this menu is mostly furniture.
      disabled: !linked,
    },
    {
      // The other half of unlinking, which had no way back. `linkClips` existed, tested, with no
      // caller — so splitting a pair was a one-way door, and the only recovery was undo.
      id: 'link',
      label: 'Link audio and video',
      disabled: !state.canLink,
    },

    {
      id: 'copy-attributes',
      label: 'Copy look',
      shortcut: 'Ctrl+Shift+C',
      disabled: target === undefined,
      separated: true,
    },
    {
      id: 'paste-attributes',
      label: 'Paste look',
      shortcut: 'Ctrl+Shift+V',
      disabled: !state.hasAttributes || nothing,
    },

    {
      id: 'remove',
      label: state.ripple ? 'Ripple delete' : 'Delete',
      shortcut: 'Del',
      disabled: nothing,
      separated: true,
      danger: true,
    },
  ];
}
