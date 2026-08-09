import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Transition } from '@nos/core';
import { cn } from '@nos/ui/lib/utils';
import type { SpanGeometry } from './viewport.js';

/**
 * A transition, drawn across the cut it joins.
 *
 * It had none. `addTransition` has existed since M3 and the clip inspector could create one, so a
 * cross-dissolve could be added, was honoured by the compositor, and appeared **nowhere on the
 * timeline** — the one place a user looks to find out what their sequence is made of. The only
 * evidence it existed was the picture changing, and the only way to find one again was to select the
 * clip that happened to be on one side of it.
 *
 * ## Why it is drawn over the cut rather than between the clips
 *
 * A transition *is* an overlap: both clips keep their material and play across the same frames. Drawn
 * as a gap it would say the opposite — that something sits between them — and the length of that gap
 * would be a lie about where each clip ends. Over the boundary, its width is exactly the frames the
 * two share.
 *
 * ## Why it sits at the top of the lane
 *
 * A band rather than a full-height block, because a full-height one hides the two things it is
 * describing. The clips stay readable underneath, which is what makes the length of the overlap
 * something you can judge by eye.
 */

export interface TransitionBodyProps {
  readonly transition: Transition;
  readonly geometry: SpanGeometry;
  /** What to call the effect. The registry knows; this component deliberately does not. */
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: (id: Transition['id']) => void;
  /** Dragging the trailing edge, which lengthens or shortens the overlap. */
  readonly onResize?: (id: Transition['id'], event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onRemove?: (id: Transition['id']) => void;
}

/** Height of the band, in pixels. Enough for a small label without covering the clips. */
export const TRANSITION_BAND_PX = 16;

export function TransitionBody({
  transition,
  geometry,
  label,
  selected,
  onSelect,
  onResize,
  onRemove,
}: TransitionBodyProps): ReactNode {
  return (
    <div
      data-transition-id={transition.id}
      role="button"
      tabIndex={0}
      aria-label={`${label} transition, ${transition.span.duration as number} frames`}
      aria-pressed={selected}
      onPointerDown={(event) => {
        // Stopped, or the clip underneath takes the press and starts a drag — the transition would be
        // selectable only in the pixels where no clip is, which is none of them.
        event.stopPropagation();
        onSelect(transition.id);
        // Focused as well as selected, which is what puts Delete on the thing you just clicked. A
        // global Delete handler would have to decide between this and the clip selection every time.
        event.currentTarget.focus();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelect(transition.id);
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          onRemove?.(transition.id);
        }
      }}
      className={cn(
        'absolute top-0 z-3 flex items-center gap-1 overflow-hidden rounded-b-sm border-x border-b',
        'bg-secondary/90 text-secondary-foreground cursor-pointer px-1',
        selected && 'ring-ring ring-2',
      )}
      style={{ left: geometry.leftPx, width: geometry.widthPx, height: TRANSITION_BAND_PX }}
    >
      {/* The glyph carries the meaning at widths where the words cannot: two edges crossing. A
          two-second dissolve at a normal zoom is a few dozen pixels wide. */}
      <CrossGlyph />
      <span className="truncate text-[10px] leading-none">{label}</span>

      {onResize !== undefined && (
        <div
          data-transition-resize={transition.id}
          aria-hidden="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            onSelect(transition.id);
            onResize(transition.id, event);
          }}
          className="hover:bg-ring/50 absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
        />
      )}
    </div>
  );
}

/**
 * Two edges crossing.
 *
 * Drawn rather than taken from the icon set, because what this has to say is specific: the outgoing
 * clip fading down as the incoming one fades up. `currentColor` so it follows the band's own
 * foreground and stays legible in every theme.
 */
function CrossGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 flex-none" fill="none">
      <path d="M1 11 L11 1" stroke="currentColor" strokeWidth="1.25" />
      <path d="M1 1 L11 11" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}
