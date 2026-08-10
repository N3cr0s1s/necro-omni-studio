import type { ReactElement, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@nos/ui/components/ui/context-menu';

/**
 * The menu a right-click opens.
 *
 * Every action it offers already exists elsewhere — on a button, behind a shortcut — which is the
 * point: a context menu is not new capability but the *discoverable* path to what a user can already
 * do. Without one, an editor's whole vocabulary is reachable only by someone who has read the
 * shortcuts.
 *
 * ## What this adds over the registry component
 *
 * Nothing visual, and that is deliberate. It turns a **list of items** into the registry's markup,
 * because the callers that need a menu — a clip, a browser row, an empty track — decide what is on it
 * from state this component cannot see, and each of them building `ContextMenuItem` elements by hand
 * would be the same eight lines written six times, drifting apart as they were edited.
 *
 * Positioning, flipping at the viewport edge, dismissal on Escape or an outside click, keyboard
 * navigation and focus return are all Base UI's. They used to be ours, and the hand-rolled version
 * flipped the menu by guessing its height from a row count.
 */

/**
 * `Id` is the caller's own vocabulary of actions, and naming it is what makes a menu safe to extend.
 *
 * A menu is two halves that have to agree: the rows that offer an action and the code that runs one.
 * With `string` on both sides they agree only by inspection — a new row with a mistyped id compiles,
 * renders, and throws when a user clicks it, which is the one moment nobody is watching a console.
 * Passing the union through instead makes that a build error at the row, where the mistake is.
 *
 * Defaulted to `string`, so a menu whose actions are not worth naming stays a one-line prop.
 */
export interface ActionMenuItem<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  /** Shown leading. A menu of bare words is slower to scan than one you can recognise by shape. */
  readonly icon?: LucideIcon;
  /** Shown trailing, so a user learns the shortcut by using the menu. */
  readonly shortcut?: string | undefined;
  readonly disabled?: boolean;
  /** Draws a rule above this item, for grouping actions of different weight. */
  readonly separated?: boolean;
  /** Destructive items are marked, because undo is a worse answer than not doing it. */
  readonly danger?: boolean;
}

/**
 * Everything a panel needs in order to have a right-click menu.
 *
 * One object rather than a pair of props, and generic in what the menu is *about*, because the two are
 * useless apart: items built for a target and a choice reported without one cannot be matched up
 * afterwards. It also removes the round-trip the previous design needed — the owner stored which clip
 * had been right-clicked, then read that state back when the action fired, which is a stale read
 * waiting to happen.
 *
 * `T` is the panel's own idea of what was clicked: a path and a flag for the browser, a clip and a
 * track for the timeline. Neither this file nor `ActionMenu` looks inside it.
 */
export interface MenuBinding<T, Id extends string = string> {
  /** Called per render of the thing that owns the menu. An empty list means no menu on that thing. */
  readonly items: (target: T) => readonly ActionMenuItem<Id>[];
  readonly onChoose: (target: T, action: Id) => void;
}

/**
 * Builds a binding from a typed item list and a handler that takes the same union.
 *
 * `MenuBinding` is invariant in `Id` — it both produces ids and consumes them — so a binding over a
 * union is not assignable to one over `string`, and the panels that *hold* a menu are declared over
 * `string` because they neither know nor care what the actions are. This is the one place that gap is
 * crossed, and the assertion inside it is sound by construction: `ActionMenu` only ever reports an id
 * it took from the very list `items` returned, so the value arriving at `onChoose` is always one of
 * the caller's own.
 *
 * Going through here rather than asserting at each call site is the whole point. The assertion was
 * previously written inline at two of them, which meant the property it depends on was restated —
 * unexamined — everywhere a menu was wired up, and a third menu would have restated it again.
 */
export function menuBinding<T, Id extends string>(
  items: (target: T) => readonly ActionMenuItem<Id>[],
  onChoose: (target: T, action: Id) => void,
): MenuBinding<T> {
  return { items, onChoose: (target, action) => onChoose(target, action as Id) };
}

export interface ActionMenuProps<Id extends string = string> {
  /** Built by the caller from whatever was clicked. An empty list means no menu at all. */
  readonly items: readonly ActionMenuItem<Id>[];
  readonly onChoose: (id: Id) => void;
  /**
   * The element the menu belongs to. It *becomes* the trigger rather than being wrapped in one, so
   * adding a menu to a row never changes that row's place in the layout.
   */
  readonly children: ReactElement;
  readonly label?: string;
}

export function ActionMenu<Id extends string = string>({
  items,
  onChoose,
  children,
  label = 'Actions',
}: ActionMenuProps<Id>): ReactNode {
  // No items means nothing to show. Returning the child untouched is better than opening an empty
  // popup, which reads as a bug rather than as "there is nothing to do here".
  if (items.length === 0) return children;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent aria-label={label} className="min-w-52">
        {items.map((item) => (
          <ActionMenuRow key={item.id} item={item} onChoose={onChoose} />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ActionMenuRow<Id extends string>({
  item,
  onChoose,
}: {
  readonly item: ActionMenuItem<Id>;
  readonly onChoose: (id: Id) => void;
}): ReactNode {
  const Icon = item.icon;

  return (
    <>
      {item.separated === true && <ContextMenuSeparator />}
      <ContextMenuItem
        disabled={item.disabled === true}
        variant={item.danger === true ? 'destructive' : 'default'}
        onClick={() => onChoose(item.id)}
      >
        {Icon !== undefined && <Icon />}
        <span className="flex-1 truncate">{item.label}</span>
        {item.shortcut !== undefined && <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut>}
      </ContextMenuItem>
    </>
  );
}
