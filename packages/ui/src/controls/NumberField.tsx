import { type ReactNode, useEffect, useState } from 'react';
import { Input } from '@nos/ui/components/ui/input';

/**
 * A number you can actually type into.
 *
 * The obvious version — a controlled `Input` writing on every `change` — cannot be typed in, and the
 * ways it fails are all silent:
 *
 * - **Clearing it writes zero.** `Number('')` is `0`, not `NaN`, so selecting the contents to replace
 *   them sets the value to zero first. On a scale channel that is a clip that vanishes; on opacity it
 *   is a black frame. The user sees the result of a keystroke they had not finished.
 * - **`-` and `0.` are not numbers.** Typing `-0.5` passes through both, so a guard that only rejected
 *   non-finite input would still refuse the two intermediate states and fight the keyboard.
 * - **The field fights itself.** Each keystroke round-trips through the document and comes back
 *   reformatted, so `0.30` becomes `0.3` under the cursor.
 *
 * So it holds a draft and commits on Enter or on blur — a user who clicks away has decided — and
 * Escape puts the committed value back. The same contract the timecode field and the inline renames
 * use, which is the point: numeric entry should not have to be learned twice in one application.
 *
 * ## Why it is here rather than in each panel
 *
 * Three panels need it — the keyframe lane, the framing controls, and anything numeric after them —
 * and the failure modes above are subtle enough that three implementations would not all have them.
 * It adds behaviour to the registry's `Input`; it does not restyle it.
 */

export interface NumberFieldProps {
  readonly value: number;
  /** Called with a finite number only, and only when the user has finished. */
  readonly onCommit: (value: number) => void;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly step?: number | undefined;
  readonly disabled?: boolean | undefined;
  /** Required: a bare number field is unusable without one, and there is always a label to give. */
  readonly 'aria-label': string;
  readonly title?: string | undefined;
  readonly className?: string | undefined;
  /** Focused and selected on mount, for a field that appears because the user asked for it. */
  readonly autoFocus?: boolean | undefined;
}

export function NumberField({
  value,
  onCommit,
  min,
  max,
  step,
  disabled,
  title,
  className,
  autoFocus,
  'aria-label': label,
}: NumberFieldProps): ReactNode {
  const [draft, setDraft] = useState<string>(() => String(value));

  // The value changes underneath the field for reasons that are not typing: an undo, a preset writing
  // keyframes, the playhead moving across an animated channel. Following it keeps the number honest.
  useEffect(() => setDraft(String(value)), [value]);

  const commit = (): void => {
    const parsed = Number(draft.trim());
    // The empty check is separate and first, because `Number('')` is `0` — the whole reason this
    // component exists.
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <Input
      type="number"
      // `any`, not the channel's step: the step governs the spinner and the arrow keys, and a field
      // that refused a typed `0.005` because its step was `0.01` would be lying about its own range.
      step={step ?? 'any'}
      aria-label={label}
      title={title}
      disabled={disabled}
      min={min}
      max={max}
      autoFocus={autoFocus}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        else if (event.key === 'Escape') setDraft(String(value));
        else {
          // Everything else belongs to the field while it has focus. The timeline's own Delete and
          // arrow keys would otherwise act on the very thing being edited.
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
      className={className}
    />
  );
}
