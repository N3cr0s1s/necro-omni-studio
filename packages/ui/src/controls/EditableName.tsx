import { type ReactNode, useEffect, useState } from 'react';
import { Input } from '@nos/ui/components/ui/input';
import { cn } from '@nos/ui/lib/utils';

/**
 * A label that becomes a field on double-click.
 *
 * Double-click rather than a pencil button: the surfaces that carry a name — a track header, the top
 * of the inspector — are already dense, and renaming is rare enough that it does not deserve permanent
 * width. Escape abandons the edit and Enter commits it, which is what every inline rename anywhere
 * does; a field that could only be left by clicking elsewhere would leave the user unsure whether
 * their change took.
 *
 * Shared rather than written per surface. Tracks had this and clips did not, so `setClipLabel` sat in
 * `@nos/editing` with nothing calling it — the engine could rename a clip and the user could not. The
 * second copy that would have fixed that is the copy that eventually behaves differently: one place
 * commits on blur, the other does not, and neither is wrong enough to notice.
 *
 * Blank is not refused here. What an empty name *means* is a question for the document — `setClipLabel`
 * rejects it, because a clip with no name renders as a rectangle nothing can refer to — and a control
 * that silently dropped the edit would hide the reason.
 */

export interface EditableNameProps {
  readonly value: string;
  /** Tooltip while not editing, for the surface to explain how to start. */
  readonly title: string;
  /** Classes for both states, so a caller controls the type scale it sits in. */
  readonly className?: string | undefined;
  /** Classes applied only while editing, when the field needs a different box from the label. */
  readonly editingClassName?: string | undefined;
  /** Opens the field without a double-click, for a rename asked for somewhere else — a menu. */
  readonly autoEdit?: boolean;
  /** Absent leaves the name read-only, which is how a locked track shows it cannot be renamed. */
  readonly onCommit?: (name: string) => void;
}

export function EditableName({
  value,
  title,
  className,
  editingClassName,
  autoEdit = false,
  onCommit,
}: EditableNameProps): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    // A rename chosen from a context menu has to land in the same field a double-click opens, or there
    // would be two ways to rename one thing that behaved differently.
    if (!autoEdit) return;
    setDraft(value);
    setEditing(true);
  }, [autoEdit, value]);

  if (!editing || onCommit === undefined) {
    return (
      <span
        title={onCommit === undefined ? value : title}
        onDoubleClick={() => {
          if (onCommit === undefined) return;
          setDraft(value);
          setEditing(true);
        }}
        className={cn('min-w-0 truncate', className)}
      >
        {value}
      </span>
    );
  }

  const finish = (commit: boolean): void => {
    setEditing(false);
    if (commit) onCommit(draft);
  };

  return (
    <Input
      // Focused on appearing: the field exists only because the user just asked for it, and anything
      // else would need a second click before they could type.
      autoFocus
      aria-label={`Rename ${value}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
        else return;
        event.preventDefault();
      }}
      className={cn('h-6 w-full min-w-0 px-1 py-0', className, editingClassName)}
    />
  );
}
