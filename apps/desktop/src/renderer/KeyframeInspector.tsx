import type { ReactNode } from 'react';
import { DiamondIcon, Trash2Icon } from 'lucide-react';
import {
  type BezierEase,
  type Easing,
  type FrameRate,
  DEFAULT_BEZIER,
  EASINGS,
  formatFrames,
  frameIndex,
} from '@nos/core';
import { NumberField } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { cn } from '@nos/ui/lib/utils';
import { BezierEditor } from './BezierEditor.js';
import type { SelectedKeyframe } from './KeyframeLanes.js';

/**
 * The selected keyframe, in the right column.
 *
 * Issue #37: *"if I click a keyframe, every one of its settings should appear in the right panel and
 * be adjustable there — that is much easier."* It is also the arrangement every editor uses, and the
 * reason is not habit: a marker is eleven pixels wide, and the lane can only afford to put a value
 * field and an easing badge on it. Everything else about it had nowhere to be.
 *
 * ## Why this does not replace the controls on the lane
 *
 * The two are for different moments. Someone shaping a curve works in the lane, where the marker sits
 * beside the ones either side of it; someone setting a title's fade to end at frame 96 exactly wants
 * a field and a number. Both write through the same operation, so a value typed here and one typed
 * there are the same edit — including the refusals.
 *
 * ## Why the frame is absolute
 *
 * Keyframes are stored clip-relative, which is what lets a clip be moved or split without its
 * animation drifting. Nobody reads them that way: the playhead, the ruler and every other field in
 * this column are timeline positions, and a marker described as "frame 12" when the ruler says 312 is
 * a number the user has to convert in their head. The conversion happens on the way in and out.
 */

export interface KeyframeInspectorProps {
  readonly selected: SelectedKeyframe;
  readonly frameRate: FrameRate;
  readonly onEdit: (change: {
    readonly frame?: ReturnType<typeof frameIndex>;
    readonly value?: number;
    readonly ease?: Easing;
    readonly bezier?: BezierEase;
  }) => void;
  readonly onRemove: () => void;
}

/** What each easing does, in the fewest words that distinguish it from its neighbours. */
const EASING_HELP: Readonly<Record<Easing, string>> = {
  linear: 'a constant rate to the next marker',
  'ease-in': 'starts slowly, arrives at full speed',
  'ease-out': 'leaves at full speed, arrives slowly',
  'ease-in-out': 'slow at both ends, fastest in the middle',
  hold: 'keeps this value until the next marker',
  bezier: 'a curve you draw yourself',
};

export function KeyframeInspector({
  selected,
  frameRate,
  onEdit,
  onRemove,
}: KeyframeInspectorProps): ReactNode {
  const { keyframe } = selected;

  return (
    <section aria-label="Keyframe" className="flex flex-col gap-2 rounded-md border p-2">
      <div className="flex items-center gap-1.5">
        <DiamondIcon aria-hidden="true" className="size-3 flex-none fill-primary text-primary" />
        <span className="truncate text-xs font-medium" title={selected.label}>
          {selected.label}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          title="Remove this keyframe"
          aria-label="Remove keyframe"
          onClick={onRemove}
        >
          <Trash2Icon className="size-3" />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="w-14 text-xs text-muted-foreground">frame</span>
        <NumberField
          aria-label="keyframe frame"
          value={selected.absoluteFrame}
          step={1}
          min={0}
          onCommit={(next) => {
            const whole = Math.round(next);
            if (whole !== selected.absoluteFrame) onEdit({ frame: frameIndex(Math.max(0, whole)) });
          }}
          className="w-24 font-mono tabular-nums"
        />
        <span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
          {formatFrames(selected.absoluteFrame, frameRate)}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="w-14 text-xs text-muted-foreground">value</span>
        <NumberField
          aria-label="keyframe value"
          value={keyframe.value}
          // Fine enough for the normalized channels — opacity, scale, most effect parameters — where a
          // step of one would jump past the whole useful range in a single press.
          step={0.01}
          onCommit={(next) => {
            if (next !== keyframe.value) onEdit({ value: next });
          }}
          className="w-24 font-mono tabular-nums"
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">easing</span>
        {selected.last ? (
          // Said rather than left blank. A row of buttons that do nothing teaches the user that easing
          // is unreliable; the sentence says it is the *last* marker that is special.
          <p className="text-[11px] text-muted-foreground">
            the last marker’s easing governs nothing — there is no segment after it
          </p>
        ) : (
          <div role="radiogroup" aria-label="easing" className="flex flex-wrap gap-1">
            {EASINGS.map((ease) => (
              <button
                key={ease}
                type="button"
                role="radio"
                aria-checked={keyframe.ease === ease}
                title={EASING_HELP[ease]}
                // Switching to a curve carries the one it had, or the default if it never had one.
                // Sending the points with the mode means a marker cannot be in `bezier` with nothing
                // to draw, which would render as a straight line the editor could not move.
                onClick={() =>
                  onEdit(ease === 'bezier' ? { ease, bezier: keyframe.bezier ?? DEFAULT_BEZIER } : { ease })
                }
                className={cn(
                  'rounded border px-1.5 py-0.5 font-mono text-[10px]',
                  keyframe.ease === ease
                    ? 'border-primary bg-primary/20 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {ease}
              </button>
            ))}
          </div>
        )}

        {/* Only while the curve is the one in use. Showing it under every easing would suggest the
            handles govern `ease-out` too, and moving them would appear to do nothing. */}
        {!selected.last && keyframe.ease === 'bezier' && (
          <BezierEditor
            points={keyframe.bezier ?? DEFAULT_BEZIER}
            // `onCommit`, not `onChange`: a drag across the box is one edit, and the live channel
            // would write a history entry per pointer move.
            onCommit={(points) => onEdit({ bezier: points })}
          />
        )}
      </div>
    </section>
  );
}
