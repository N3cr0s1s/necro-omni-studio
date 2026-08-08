import { ExternalLinkIcon, FolderPlusIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { PROJECT_FOLDERS } from '@nos/core';
import type { ActionMenuItem } from '@nos/ui';

/**
 * What a right-click in the project browser offers.
 *
 * The browser could show the project folder and do nothing to it: no way to make a folder, rename a
 * file, delete one, or move anything. "A project is a folder" was true right up to the point where
 * you wanted to organise it, and then you had to leave the application to do it.
 *
 * Kept as a value, like the timeline's menu, for the same reason: what is offered depends on the
 * *kind* of thing under the pointer and on which folder it is in, and those are questions about the
 * project rather than about rendering. A rendered menu cannot be tested for the one property that
 * matters here — that a reserved folder is never offered for deletion.
 */

export const BROWSER_MENU_ACTIONS = ['new-folder', 'rename', 'reveal', 'delete'] as const;

export type BrowserMenuAction = (typeof BROWSER_MENU_ACTIONS)[number];

export interface BrowserMenuState {
  /** The row under the pointer, absent for a right-click on empty space. */
  readonly path: string | undefined;
  readonly isDirectory: boolean;
}

/**
 * The reserved folders, which the application creates and depends on.
 *
 * Renaming or deleting one would leave a project whose `media/` is missing while every clip still
 * points into it — recoverable only by hand. They are protected here rather than by a confirmation
 * dialog, because a dialog is a question with a wrong answer available.
 */
export function isReservedFolder(path: string): boolean {
  return (Object.values(PROJECT_FOLDERS) as readonly string[]).includes(path);
}

/** True for a file the project cannot do without. */
export function isProjectDocument(path: string): boolean {
  return path === 'project.json';
}

export function browserMenuItems(state: BrowserMenuState): readonly ActionMenuItem[] {
  const path = state.path;
  const protectedEntry = path !== undefined && (isReservedFolder(path) || isProjectDocument(path));
  const reason = protectedEntry ? ' — the project needs this one' : '';

  return [
    {
      id: 'new-folder',
      // Always available, including on empty space: making the first folder is exactly when there is
      // nothing to right-click on.
      label: state.isDirectory && path !== undefined ? `New folder in ${basename(path)}` : 'New folder',
      icon: FolderPlusIcon,
    },
    {
      id: 'rename',
      label: `Rename${reason}`,
      icon: PencilIcon,
      disabled: path === undefined || protectedEntry,
      separated: true,
    },
    {
      id: 'reveal',
      label: 'Show in file manager',
      icon: ExternalLinkIcon,
      disabled: path === undefined,
    },
    {
      id: 'delete',
      label: `Move to trash${reason}`,
      icon: Trash2Icon,
      disabled: path === undefined || protectedEntry,
      separated: true,
      danger: true,
    },
  ];
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Where a renamed entry ends up.
 *
 * A rename changes the *name*, never the folder: typing a path into the field would move the file
 * somewhere the user cannot see from where they are standing, which is a surprise rather than a
 * feature. Moving is dragging, where the destination is visible the whole time.
 */
export function renamedPath(path: string, name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === basename(path)) return undefined;
  // Separators would make a rename into a move; the leading dot would make the file invisible in a
  // browser that hides nothing else, which reads as the file having been deleted.
  if (/[/\\]/u.test(trimmed) || trimmed.startsWith('.')) return undefined;

  const parent = path.lastIndexOf('/');
  return parent === -1 ? trimmed : `${path.slice(0, parent)}/${trimmed}`;
}

/**
 * Where a dragged entry lands, or `undefined` when the drag means nothing.
 *
 * Refuses the moves that are not moves — into its own folder, onto itself — and the one that
 * destroys a subtree: dragging a folder into its own descendant, which on most filesystems either
 * fails obscurely or succeeds and orphans everything below.
 */
export function movedPath(source: string, destinationFolder: string): string | undefined {
  const name = basename(source);
  const target = destinationFolder === '' ? name : `${destinationFolder}/${name}`;

  if (target === source) return undefined;
  if (destinationFolder === parentOf(source)) return undefined;
  if (destinationFolder === source || destinationFolder.startsWith(`${source}/`)) return undefined;

  return target;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * A folder name that will not surprise anyone.
 *
 * Applied to what the user typed rather than refusing it: a name with a slash in it is a reasonable
 * thing to type and an unreasonable thing to create, and silently making one folder called `a/b` is
 * worse than either.
 */
export function sanitizeFolderName(name: string): string | undefined {
  const cleaned = name
    .trim()
    .replace(/[/\\:*?"<>|]+/gu, '-')
    .replace(/^\.+/u, '');
  return cleaned === '' ? undefined : cleaned;
}
