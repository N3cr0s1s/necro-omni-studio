import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react';
import {
  type FrameIndex,
  type FrameRate,
  describeSeekEntryError,
  parseSeekEntry,
  seekEntryText,
} from '@nos/core';
import { Button } from '@nos/ui/components/ui/button';
import { Input } from '@nos/ui/components/ui/input';

/**
 * The transport's timecode, typed into as well as read.
 *
 * It was a `<span>`: the position was shown and there was no way to go to one. Every other way of
 * reaching an exact frame — dragging the playhead, arrowing frame by frame — is either imprecise or
 * slow, and "go to 00:01:14:03" is what a note from someone else always says.
 *
 * Three behaviours, and each exists because its absence is what makes a timecode field annoying:
 *
 * - **It shows the position while it is not being edited.** A field holding stale text while the
 *   playhead moves under it is worse than no field.
 * - **Escape abandons and Enter commits.** A committed edit that could only be undone by retyping
 *   the old value would make experimenting with it costly.
 * - **A refusal keeps the text.** Clearing the field on a bad entry destroys the thing the user was
 *   about to correct, and tells them nothing about what was wrong.
 *
 * What the text *means* — partial entry, relative moves, frames, drop-frame — is `parseSeekEntry`'s,
 * where it is decided without a rendered input.
 */

export interface TimecodeFieldProps {
  readonly frame: FrameIndex;
  readonly frameRate: FrameRate;
  /** One past the last seekable frame, so an entry past the end lands on it rather than failing. */
  readonly duration?: number;
  readonly onSeek?: (frame: FrameIndex) => void;
}

export function TimecodeField({ frame, frameRate, duration, onSeek }: TimecodeFieldProps): ReactNode {
  const shown = seekEntryText(frame, frameRate);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  // A seek from anywhere else — the ruler, the keyboard, playback — ends the edit. Continuing to
  // hold a draft while the playhead moved would commit it against a position the user has left.
  useEffect(() => {
    setDraft(undefined);
    setProblem(undefined);
  }, [frame]);

  if (draft === undefined || onSeek === undefined) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Current time ${shown}`}
        title="Click to type a timecode, a frame number, or a relative move like +30"
        disabled={onSeek === undefined}
        onClick={() => setDraft(shown)}
        className="font-mono tabular-nums"
      >
        {shown}
      </Button>
    );
  }

  const commit = (): void => {
    const parsed = parseSeekEntry(draft, {
      rate: frameRate,
      current: frame,
      ...(duration !== undefined ? { duration } : {}),
    });

    if (!parsed.ok) {
      // The text stays. Clearing it would destroy the thing the user was about to correct.
      setProblem(describeSeekEntryError(parsed.error, frameRate));
      return;
    }

    setProblem(undefined);
    setDraft(undefined);
    onSeek(parsed.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') commit();
    else if (event.key === 'Escape') {
      setDraft(undefined);
      setProblem(undefined);
    } else {
      // Everything else, including the transport's own space and arrow shortcuts, belongs to the
      // field while it has focus — a space bar that started playback mid-edit would be unusable.
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Input
        autoFocus
        aria-label="Go to timecode"
        aria-invalid={problem !== undefined}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setProblem(undefined);
        }}
        onFocus={(event) => event.target.select()}
        onKeyDown={handleKeyDown}
        // Committing on blur, like every inline field here: a user who clicks away has decided.
        onBlur={commit}
        // `aria-invalid` is what paints the refusal: the registry's Input already draws that state,
        // so there is nothing to colour here.
        className="h-7 w-[12ch] font-mono tabular-nums"
      />
      {problem !== undefined && (
        <span role="alert" className="text-xs text-destructive">
          {problem}
        </span>
      )}
    </span>
  );
}
