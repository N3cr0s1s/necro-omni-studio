import { type ClipId, type TimelineDocument, linkedPartner, locateClip } from '@nos/core';
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
  readonly selectionSize: number;
  readonly canPaste: boolean;
  readonly hasAttributes: boolean;
  /** True when removing closes the gap, so the label can say which removal this is. */
  readonly ripple: boolean;
}

export const CLIP_MENU_ACTIONS = [
  'cut',
  'copy',
  'paste',
  'duplicate',
  'split',
  'toggle-enabled',
  'unlink',
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

  return [
    { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X', disabled: nothing },
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
