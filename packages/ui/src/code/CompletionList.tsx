import { type ReactNode, useEffect, useRef } from 'react';
import type { Completion } from '@nos/core';
import { cn } from '@nos/ui/lib/utils';

/**
 * The suggestions at a caret — issue #31.
 *
 * Presentational only: it draws a list and says which entry is highlighted. Which entries exist, what
 * accepting one writes, and every key that moves the highlight are the editor's, because they are the
 * parts worth testing without a DOM.
 *
 * ## Why it is not a `listbox` the user can focus
 *
 * Focus stays in the textarea the whole time — that is the entire point of an inline completion, and
 * moving it to a list would take the caret off screen and break IME composition. So the list is
 * `aria-live` off and referenced by the textarea through `aria-activedescendant` instead, which is the
 * combobox pattern: the input keeps focus and announces the active option.
 */

export interface CompletionListProps {
  readonly completions: readonly Completion[];
  /** Index into `completions`. Always valid while the list is shown. */
  readonly active: number;
  /** Where to draw it, in pixels relative to the positioned ancestor — under the caret. */
  readonly left: number;
  readonly top: number;
  readonly onAccept: (index: number) => void;
  /** Prefix for option ids, so the textarea can point at the active one. */
  readonly idPrefix: string;
}

export function CompletionList({
  completions,
  active,
  left,
  top,
  onAccept,
  idPrefix,
}: CompletionListProps): ReactNode {
  const activeRef = useRef<HTMLLIElement | null>(null);

  // Scrolled into view rather than left to the user: arrowing past the eighth entry of a list that
  // does not follow is indistinguishable from a list that stopped responding.
  useEffect(() => {
    // Optional call: jsdom does not implement it, and the list is still correct without scrolling.
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (completions.length === 0) return undefined;

  return (
    <ul
      id={idPrefix}
      role="listbox"
      aria-label="Suggestions"
      className="bg-popover text-popover-foreground absolute z-50 max-h-56 w-80 overflow-y-auto rounded-md border p-1 shadow-md"
      style={{ left, top }}
    >
      {completions.map((completion, index) => (
        <li
          key={completion.label}
          id={`${idPrefix}-${index}`}
          ref={index === active ? activeRef : undefined}
          role="option"
          aria-selected={index === active}
          // `onMouseDown` rather than `onClick`: a click would blur the textarea first, and the caret
          // position the insertion depends on is gone by the time the handler runs.
          onMouseDown={(event) => {
            event.preventDefault();
            onAccept(index);
          }}
          className={cn(
            'flex cursor-pointer flex-col rounded-sm px-2 py-1',
            index === active && 'bg-accent text-accent-foreground',
          )}
        >
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-xs">{completion.label}</span>
            {completion.detail !== undefined && (
              <span className="text-muted-foreground truncate font-mono text-[10px]">
                {completion.detail}
              </span>
            )}
            {/* Marked, so a half-written manifest shows what it still owes rather than only what it
                could have. */}
            {completion.required === true && (
              <span className="text-muted-foreground ml-auto text-[10px]">required</span>
            )}
          </span>
          {completion.doc !== undefined && (
            <span className="text-muted-foreground text-[11px] leading-snug">{completion.doc}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
