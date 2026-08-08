import { type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import {
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  GripVerticalIcon,
  PlusIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import type { EffectInstance, EffectInstanceId } from '@nos/core';
import { Alert, AlertTitle } from '@nos/ui/components/ui/alert';
import { Button } from '@nos/ui/components/ui/button';
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@nos/ui/components/ui/item';
import { cn } from '@nos/ui/lib/utils';

/**
 * The clip's effect stack.
 *
 * Order is the render order — each pass feeds the next — so reordering is a real edit, not a display
 * preference. The spec requires drag-and-drop reordering; this also supports keyboard reordering, because
 * a drag-only control is unusable without a pointer and the operation is far too important to gate on one.
 *
 * Implemented with pointer events rather than HTML5 drag-and-drop. Native DnD cannot be driven from the
 * keyboard, gives no control over the drag image, and its event model fights React's; pointer events cost
 * a few more lines and behave identically everywhere.
 */

export interface EffectStackEntry {
  readonly instance: EffectInstance;
  /** Display name from the manifest. Falls back to the effect id when unregistered. */
  readonly label: string;
  /** Number of keyframed parameters, for the `2 kf` badge. */
  readonly keyframeCount: number;
  /**
   * Compile failure, if the shader is broken.
   *
   * Present means the effect is in passthrough. The spec requires the compiler message to be shown here
   * with its line number rather than swallowed, because that is the only feedback a shader author gets.
   */
  readonly error?: string;
  /** True when the effect id is not in the registry at all. */
  readonly unregistered?: boolean;
}

export interface EffectStackProps {
  readonly entries: readonly EffectStackEntry[];
  readonly selected?: EffectInstanceId;
  /** Passes above this earn a warning, per the spec's budget of 8. */
  readonly passWarningThreshold?: number;
  readonly onSelect?: (instance: EffectInstanceId) => void;
  readonly onToggleEnabled?: (instance: EffectInstanceId, enabled: boolean) => void;
  readonly onRemove?: (instance: EffectInstanceId) => void;
  /** Reports a completed reorder as a single move. */
  readonly onReorder?: (from: number, to: number) => void;
  readonly onAdd?: () => void;
}

export function EffectStack({
  entries,
  selected,
  passWarningThreshold = 8,
  onSelect,
  onToggleEnabled,
  onRemove,
  onReorder,
  onAdd,
}: EffectStackProps): ReactNode {
  const [dragIndex, setDragIndex] = useState<number | undefined>(undefined);
  const [dropIndex, setDropIndex] = useState<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement | null>(null);

  const enabledCount = entries.filter((entry) => entry.instance.enabled).length;
  const overBudget = enabledCount > passWarningThreshold;

  const finishDrag = useCallback(() => {
    if (dragIndex !== undefined && dropIndex !== undefined && dragIndex !== dropIndex) {
      onReorder?.(dragIndex, dropIndex);
    }
    setDragIndex(undefined);
    setDropIndex(undefined);
  }, [dragIndex, dropIndex, onReorder]);

  /**
   * Resolves the row index under a pointer.
   *
   * Measured from the DOM rather than tracked through enter/leave events: with the dragged row following
   * the pointer, enter/leave fire unpredictably, and hit-testing the container is both simpler and
   * correct at the edges.
   */
  const indexAtPointer = useCallback((clientY: number): number | undefined => {
    const container = listRef.current;
    if (container === null) return undefined;

    const rows = [...container.querySelectorAll('[data-effect-row]')];
    for (const [index, row] of rows.entries()) {
      const bounds = row.getBoundingClientRect();
      if (clientY < bounds.bottom) return index;
    }
    return rows.length === 0 ? undefined : rows.length - 1;
  }, []);

  return (
    <section aria-label="Effect stack" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Effect stack
        </span>
        <span
          className={cn(
            'ml-auto font-mono text-xs',
            overBudget ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {enabledCount} / {passWarningThreshold} passes
        </span>
      </div>

      {overBudget && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Above {passWarningThreshold} passes — preview may not hold realtime</AlertTitle>
        </Alert>
      )}

      <ItemGroup
        ref={listRef}
        role="list"
        onPointerMove={(event) => {
          if (dragIndex === undefined) return;
          setDropIndex(indexAtPointer(event.clientY));
        }}
        onPointerUp={finishDrag}
        // A pointer leaving the window mid-drag must not leave the list stuck in drag state.
        onPointerLeave={() => {
          if (dragIndex !== undefined) finishDrag();
        }}
        className="gap-2"
      >
        {entries.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">No effects on this clip</p>
        ) : (
          entries.map((entry, index) => (
            <EffectRow
              key={entry.instance.id}
              entry={entry}
              index={index}
              total={entries.length}
              selected={selected === entry.instance.id}
              dragging={dragIndex === index}
              dropTarget={dragIndex !== undefined && dropIndex === index && dragIndex !== index}
              onPointerDownHandle={() => {
                setDragIndex(index);
                setDropIndex(index);
              }}
              {...(onSelect !== undefined ? { onSelect } : {})}
              {...(onToggleEnabled !== undefined ? { onToggleEnabled } : {})}
              {...(onRemove !== undefined ? { onRemove } : {})}
              {...(onReorder !== undefined ? { onReorder } : {})}
            />
          ))
        )}
      </ItemGroup>

      <Button variant="outline" size="sm" onClick={onAdd} className="w-full border-dashed">
        <PlusIcon />
        Add effect from registry
      </Button>
    </section>
  );
}

function EffectRow({
  entry,
  index,
  total,
  selected,
  dragging,
  dropTarget,
  onPointerDownHandle,
  onSelect,
  onToggleEnabled,
  onRemove,
  onReorder,
}: {
  readonly entry: EffectStackEntry;
  readonly index: number;
  readonly total: number;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly onPointerDownHandle: () => void;
  readonly onSelect?: (instance: EffectInstanceId) => void;
  readonly onToggleEnabled?: (instance: EffectInstanceId, enabled: boolean) => void;
  readonly onRemove?: (instance: EffectInstanceId) => void;
  readonly onReorder?: (from: number, to: number) => void;
}): ReactNode {
  const broken = entry.error !== undefined || entry.unregistered === true;

  /**
   * Keyboard reordering.
   *
   * Alt+Arrow rather than plain Arrow, so arrows stay available for moving between rows. This is the only
   * way to reorder without a pointer, and reordering changes render output — it is not an optional
   * convenience.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!event.altKey) return;
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      onReorder?.(index, index - 1);
    } else if (event.key === 'ArrowDown' && index < total - 1) {
      event.preventDefault();
      onReorder?.(index, index + 1);
    }
  };

  const HealthIcon = broken ? CircleAlertIcon : entry.instance.enabled ? EyeIcon : EyeOffIcon;

  return (
    <Item
      role="listitem"
      variant="outline"
      size="xs"
      data-effect-row={entry.instance.id}
      data-index={index}
      aria-label={`${entry.label}, pass ${index + 1} of ${total}`}
      aria-current={selected ? 'true' : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={() => onSelect?.(entry.instance.id)}
      className={cn(
        (selected || dropTarget) && 'border-ring bg-accent',
        // The dragged row dims rather than following the pointer: a floating copy over a narrow panel
        // obscures the very targets the user is aiming at.
        dragging ? 'opacity-45' : !entry.instance.enabled && 'opacity-50',
      )}
    >
      <ItemMedia>
        <span
          data-drag-handle
          aria-hidden="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            onPointerDownHandle();
          }}
          className="cursor-grab touch-none text-muted-foreground"
        >
          <GripVerticalIcon className="size-3.5" />
        </span>
      </ItemMedia>

      <ItemContent className="min-w-0">
        <ItemTitle className={cn('truncate', broken && 'text-destructive')}>{entry.label}</ItemTitle>
      </ItemContent>

      <ItemActions className="gap-1.5">
        <span className="font-mono text-xs text-muted-foreground">
          {entry.keyframeCount > 0 ? `${entry.keyframeCount} kf` : '—'}
        </span>

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`${entry.instance.enabled ? 'Disable' : 'Enable'} ${entry.label}`}
          aria-pressed={entry.instance.enabled}
          onClick={(event) => {
            event.stopPropagation();
            onToggleEnabled?.(entry.instance.id, !entry.instance.enabled);
          }}
          title={healthTitle(entry)}
        >
          {/* The icon carries the health as well as the action, and names it: a bare dot conveys
              nothing to a screen reader, and a broken shader is the one state worth announcing. */}
          <HealthIcon
            role="img"
            aria-label={healthTitle(entry)}
            className={cn(broken && 'text-destructive')}
          />
        </Button>

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${entry.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove?.(entry.instance.id);
          }}
        >
          <XIcon />
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * Health description for the status icon.
 *
 * A broken shader reports its compiler message, which the spec requires to be visible with its line
 * number — it is the only feedback a shader author gets, and hiding it makes authoring impractical.
 */
function healthTitle(entry: EffectStackEntry): string {
  if (entry.unregistered === true) return 'This effect is not in the registry — pass skipped';
  if (entry.error !== undefined) return `Shader error (passthrough): ${entry.error}`;
  return entry.instance.enabled ? 'Enabled' : 'Disabled';
}

/**
 * Moves an item in an array, returning a new one.
 *
 * Exported because both the pointer and keyboard paths report a move as `(from, to)` and the caller
 * applies it to the document; keeping the index arithmetic in one tested place avoids two subtly
 * different implementations.
 */
export function reorder<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to) return items;
  if (from < 0 || from >= items.length) return items;

  const clampedTo = Math.min(Math.max(to, 0), items.length - 1);
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(clampedTo, 0, moved);
  return next;
}
