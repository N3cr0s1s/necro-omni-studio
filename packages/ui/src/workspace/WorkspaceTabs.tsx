import type { ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import { cn } from '@nos/ui/lib/utils';

/**
 * The window's tab bar.
 *
 * Issue #31 asks for tabs at the framework level, and #30 for them to be **line tabs** spanning the
 * full width. Both are here because they are the same bar: a line tab reads as a strip along the top
 * of what it belongs to, which is exactly what a workspace tab is — a whole surface, not a segmented
 * control choosing between three small panels.
 *
 * ## What it knows, which is almost nothing
 *
 * A tab is an id, a title and whether it closes. The bar never learns what a kind *is*; the caller
 * decides that from its own descriptor and renders whatever the active tab is. That is what makes a
 * new kind an entry rather than an edit here.
 */

export interface WorkspaceTabView {
  readonly id: string;
  readonly title: string;
  /** Drawn to the left of the title. The caller picks it per kind, so the bar has no icon table. */
  readonly icon?: ReactNode;
  readonly closable: boolean;
}

export interface WorkspaceTabsProps {
  readonly tabs: readonly WorkspaceTabView[];
  readonly active: string;
  readonly onSelect: (id: string) => void;
  readonly onClose?: (id: string) => void;
  /** Trailing controls — the window's own actions, which belong on this row rather than below it. */
  readonly children?: ReactNode;
}

export function WorkspaceTabs({ tabs, active, onSelect, onClose, children }: WorkspaceTabsProps): ReactNode {
  return (
    <div
      role="tablist"
      aria-label="Workspace"
      // A line along the full width: the underline of the active tab and the bar's own bottom border
      // are the same line, which is what makes it read as a *sheet* rather than as a group of buttons.
      className="border-border flex h-9 w-full flex-none items-stretch border-b"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            className={cn(
              'group/tab relative flex items-center gap-2 pr-1 pl-3',
              // The active tab's line sits *over* the bar's border, so the two never double up into a
              // two-pixel edge.
              selected ? 'border-primary -mb-px border-b-2' : 'border-b-2 border-transparent',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(tab.id)}
              className={cn(
                'flex items-center gap-2 py-1 text-xs whitespace-nowrap',
                selected ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.icon}
              {tab.title}
            </button>

            {tab.closable && (
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={() => onClose?.(tab.id)}
                // Always rendered, never hidden until hover: a control that appears on hover cannot be
                // found by anyone who does not already know it is there, and it moves the layout when
                // it arrives.
                className={cn(
                  'text-muted-foreground hover:text-foreground rounded-sm p-0.5',
                  'hover:bg-accent',
                )}
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>
        );
      })}

      {/* The rest of the line, so the bar is a full-width rule rather than a row of tabs floating in
          space — which is what #30 asks for. */}
      <div className="flex flex-1 items-center justify-end gap-2 px-2">{children}</div>
    </div>
  );
}
