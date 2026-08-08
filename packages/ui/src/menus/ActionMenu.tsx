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

export interface ActionMenuItem {
  readonly id: string;
  readonly label: string;
  /** Shown leading. A menu of bare words is slower to scan than one you can recognise by shape. */
  readonly icon?: LucideIcon;
  /** Shown trailing, so a user learns the shortcut by using the menu. */
  readonly shortcut?: string;
  readonly disabled?: boolean;
  /** Draws a rule above this item, for grouping actions of different weight. */
  readonly separated?: boolean;
  /** Destructive items are marked, because undo is a worse answer than not doing it. */
  readonly danger?: boolean;
}

export interface ActionMenuProps {
  /** Built by the caller from whatever was clicked. An empty list means no menu at all. */
  readonly items: readonly ActionMenuItem[];
  readonly onChoose: (id: string) => void;
  /**
   * The element the menu belongs to. It *becomes* the trigger rather than being wrapped in one, so
   * adding a menu to a row never changes that row's place in the layout.
   */
  readonly children: ReactElement;
  readonly label?: string;
}

export function ActionMenu({ items, onChoose, children, label = 'Actions' }: ActionMenuProps): ReactNode {
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

function ActionMenuRow({
  item,
  onChoose,
}: {
  readonly item: ActionMenuItem;
  readonly onChoose: (id: string) => void;
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
