import { type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, CircleXIcon, PlayIcon, SquareIcon, XIcon } from 'lucide-react';
import {
  type VariantCandidate,
  type VariantSelection,
  describeSelection,
  stepSelection,
} from '@nos/generators';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@nos/ui/components/ui/card';
import { Progress } from '@nos/ui/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@nos/ui/components/ui/toggle-group';
import { cn } from '@nos/ui/lib/utils';

/**
 * In-place variant picking (mockup 1d).
 *
 * The spec is explicit that this is **not** a modal chooser: a music bed or a cutaway can only be judged
 * where it will live, so the picker is anchored over the placeholder on the timeline and the surrounding
 * edit stays visible and editable behind it.
 *
 * Three behaviours follow from that and are the reason this component exists at all:
 *
 * - **Partial results are usable.** Ready candidates are selectable the moment they land; the rest are
 *   shown as still coming rather than blocking the control.
 * - **Auditioning happens in context.** The play control asks the caller to move the playhead over the
 *   staged clip, not to open a preview window.
 * - **Nothing is destroyed.** Discarding removes the placeholder; the generated files stay where they are.
 *
 * Position is the caller's business — the timeline knows where the placeholder is. This renders as an
 * absolutely-positioned card and takes its coordinates through `style`.
 */

export interface VariantPickerProps {
  readonly selection: VariantSelection;
  /** True while the staged clip is playing, so the transport control reflects reality. */
  readonly auditioning?: boolean;
  readonly style?: CSSProperties | undefined;

  /**
   * Reports the chosen candidate's key.
   *
   * The **only** channel by which the selection changes, stepping included. There used to be a second
   * one — `onStep(delta)`, with the caller working out which candidate that landed on — and the caller
   * got it wrong in a way nothing could catch: it reported the new candidate's *run*, and a batched run
   * carries several candidates, so the key never matched and every step fell back to the first variant.
   * Stepping is a pure function of the selection and a delta, so it happens here and arrives as a key
   * like any other choice.
   */
  readonly onSelect?: ((candidate: string) => void) | undefined;
  readonly onAudition?: (() => void) | undefined;
  readonly onAccept?: (() => void) | undefined;
  readonly onDiscard?: (() => void) | undefined;
}

export function VariantPicker({
  selection,
  auditioning = false,
  style,
  onSelect,
  onAudition,
  onAccept,
  onDiscard,
}: VariantPickerProps): ReactNode {
  const current = selection.current;
  const canAccept = current !== undefined;
  const canStep = selection.readyCount > 1;

  /** Moves to another ready candidate, wrapping. Reported as a key, exactly like a click on a chip. */
  function step(delta: number): void {
    const next = stepSelection(selection, delta).current;
    if (next !== undefined && next.key !== current?.key) onSelect?.(next.key);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Arrow keys because comparing variants is a back-and-forth, and reaching for the mouse between each
    // comparison is what makes a chooser feel slow.
    switch (event.key) {
      case 'ArrowLeft':
        step(-1);
        break;
      case 'ArrowRight':
        step(1);
        break;
      case 'Enter':
        if (canAccept) onAccept?.();
        break;
      case 'Escape':
        onDiscard?.();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <Card
      role="group"
      aria-label={`Variants for ${selection.label}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      // `chart-4` is what the whole application uses for "a generator made this", so the picker is
      // edged in it. The mockups made that meaning exact and it survives the change of palette.
      className="min-w-58 gap-3 border-chart-4/40 py-3 shadow-lg"
      style={style}
    >
      <CardHeader className="flex-row items-center gap-3 px-3">
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Variants
        </CardTitle>
        <span className="ml-auto font-mono text-xs text-chart-4">{describeSelection(selection)}</span>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-3">
        <ToggleGroup
          aria-label="Variant"
          value={current === undefined ? [] : [current.key]}
          onValueChange={(value) => {
            const chosen = value.at(-1);
            if (chosen !== undefined) onSelect?.(chosen);
          }}
          className="flex-wrap justify-start"
        >
          {selection.candidates.map((candidate) => (
            <CandidateChip
              // Keyed and compared by the candidate's own key, never by its run: a batched run carries
              // several variants, so three chips would share one React key and all highlight together.
              key={candidate.key}
              candidate={candidate}
            />
          ))}
        </ToggleGroup>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!canStep}
            onClick={() => step(-1)}
            aria-label="Previous variant"
            title="Previous variant (←)"
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant={auditioning ? 'secondary' : 'outline'}
            size="sm"
            disabled={!canAccept}
            onClick={onAudition}
            title="Play the staged clip in place"
            className="flex-1"
          >
            {auditioning ? <SquareIcon /> : <PlayIcon />}
            {auditioning ? 'Stop' : 'Audition'}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!canStep}
            onClick={() => step(1)}
            aria-label="Next variant"
            title="Next variant (→)"
          >
            <ChevronRightIcon />
          </Button>
        </div>

        {current !== undefined && (
          // The seed is provenance: it is what makes a variant reproducible later, so it is shown rather
          // than kept in the job record only.
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="text-muted-foreground">seed</span>
            <span className="text-chart-4">{current.seed}</span>
          </div>
        )}

        {selection.exhausted && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <CircleXIcon className="size-3.5 shrink-0" />
            {firstError(selection.candidates)}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!canAccept}
            onClick={onAccept}
            title={canAccept ? 'Keep this variant (Enter)' : 'No variant is ready yet'}
            className="flex-1"
          >
            Keep
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            title="Remove the placeholder; generated files are kept (Esc)"
          >
            Discard
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One candidate chip.
 *
 * A pending candidate is shown rather than hidden: seeing `3` greyed with its progress is what tells the
 * user that more is coming, and a chip list that grew as results arrived would move the target under a
 * clicking finger.
 *
 * The progress fill is a `Progress` behind the ordinal rather than a spinner — it reads at this size and
 * says how far along the run is, which is what decides whether waiting is worth it.
 */
function CandidateChip({ candidate }: { readonly candidate: VariantCandidate }): ReactNode {
  const failed = candidate.status === 'failed' || candidate.status === 'cancelled';
  const running = candidate.progress !== undefined && !candidate.ready && !failed;

  return (
    <ToggleGroupItem
      value={candidate.key}
      aria-label={chipLabel(candidate)}
      disabled={!candidate.ready}
      className={cn('relative min-w-9 overflow-hidden font-mono', failed && 'text-destructive')}
    >
      {running && (
        <Progress
          aria-hidden="true"
          value={Math.min(1, Math.max(0, candidate.progress ?? 0)) * 100}
          className="absolute inset-0 block opacity-30 [&_[data-slot=progress-indicator]]:bg-chart-4 [&_[data-slot=progress-track]]:h-full [&_[data-slot=progress-track]]:rounded-none"
        />
      )}
      <span className="relative">{failed ? <XIcon /> : candidate.ordinal}</span>
    </ToggleGroupItem>
  );
}

function chipLabel(candidate: VariantCandidate): string {
  if (candidate.ready) return `Variant ${candidate.ordinal}`;
  if (candidate.status === 'failed') return `Variant ${candidate.ordinal} failed`;
  if (candidate.status === 'cancelled') return `Variant ${candidate.ordinal} cancelled`;
  return `Variant ${candidate.ordinal} generating`;
}

function firstError(candidates: readonly VariantCandidate[]): string {
  const failed = candidates.find((candidate) => candidate.error !== undefined);
  return failed?.error ?? 'every variant failed';
}

/**
 * The placeholder body a picker anchors to.
 *
 * Rendered on the staging lane rather than the target track: the spec's mockup `1f` keeps pending output
 * out of the cut entirely, so a job that is still running provably cannot disturb an edit in progress.
 */
export function VariantPlaceholder({
  selection,
  left,
  width,
  height,
  provisional = false,
  selected = false,
  onClick,
}: {
  readonly selection: VariantSelection;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  /** True when the length is a stand-in because the manifest discovers it. */
  readonly provisional?: boolean | undefined;
  readonly selected?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
}): ReactNode {
  return (
    <Button
      variant="ghost"
      aria-label={`${selection.label} placeholder`}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'absolute top-0 justify-start gap-2 overflow-hidden border bg-chart-4/10 px-2 text-xs whitespace-nowrap text-chart-4',
        // Dashed while the length is provisional: a solid edge would claim a precision the manifest does
        // not have, and the clip is about to change length.
        provisional ? 'border-dashed' : 'border-solid',
        selected ? 'border-2 border-chart-4' : 'border-chart-4/40',
      )}
      style={{ left, width: Math.max(2, width), height }}
    >
      <Badge variant="secondary" className="font-mono">
        {`${selection.readyCount}/${selection.totalCount}`}
      </Badge>
      <span className="truncate">{selection.label}</span>
    </Button>
  );
}
