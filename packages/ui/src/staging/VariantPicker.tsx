import { type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { JobRunId } from '@nos/core';
import {
  type VariantCandidate,
  type VariantSelection,
  describeSelection,
} from '@nos/generators';
import { Badge, Button, Mono, SectionCaption } from '../primitives/Primitives.js';
import { token } from '../tokens/tokens.js';

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

  readonly onSelect?: ((run: JobRunId) => void) | undefined;
  readonly onStep?: ((delta: number) => void) | undefined;
  readonly onAudition?: (() => void) | undefined;
  readonly onAccept?: (() => void) | undefined;
  readonly onDiscard?: (() => void) | undefined;
}

export function VariantPicker({
  selection,
  auditioning = false,
  style,
  onSelect,
  onStep,
  onAudition,
  onAccept,
  onDiscard,
}: VariantPickerProps): ReactNode {
  const current = selection.current;
  const canAccept = current !== undefined;
  const canStep = selection.readyCount > 1;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Arrow keys because comparing variants is a back-and-forth, and reaching for the mouse between each
    // comparison is what makes a chooser feel slow.
    switch (event.key) {
      case 'ArrowLeft':
        onStep?.(-1);
        break;
      case 'ArrowRight':
        onStep?.(1);
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
    <div
      role="group"
      aria-label={`Variants for ${selection.label}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: token.space3,
        padding: token.space4,
        minWidth: 232,
        borderRadius: token.radiusCard,
        // Purple, because the framework produced this. The mockups keep that meaning exact.
        background: token.surface1,
        border: `1px solid ${token.generatedDim}`,
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.55)',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: token.space3 }}>
        <SectionCaption>Variants</SectionCaption>
        <div style={{ flex: 1 }} />
        <Mono tone={token.generatedText}>{describeSelection(selection)}</Mono>
      </div>

      <div
        role="radiogroup"
        aria-label="Variant"
        style={{ display: 'flex', gap: token.space2, flexWrap: 'wrap' }}
      >
        {selection.candidates.map((candidate) => (
          <CandidateChip
            key={candidate.run}
            candidate={candidate}
            selected={candidate.run === current?.run}
            {...(onSelect !== undefined ? { onSelect } : {})}
          />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: token.space2 }}>
        <Button disabled={!canStep} onClick={() => onStep?.(-1)} title="Previous variant (←)">
          ◀
        </Button>
        <Button
          tone={auditioning ? 'active' : 'default'}
          disabled={!canAccept}
          onClick={onAudition}
          title="Play the staged clip in place"
          style={{ flex: 1, justifyContent: 'center' }}
        >
          {auditioning ? 'Stop' : 'Audition'}
        </Button>
        <Button disabled={!canStep} onClick={() => onStep?.(1)} title="Next variant (→)">
          ▶
        </Button>
      </div>

      {current !== undefined && (
        // The seed is provenance: it is what makes a variant reproducible later, so it is shown rather
        // than kept in the job record only.
        <div style={{ display: 'flex', alignItems: 'center', gap: token.space2 }}>
          <Mono tone={token.textFaint}>seed</Mono>
          <Mono tone={token.generatedDim}>{current.seed}</Mono>
        </div>
      )}

      {selection.exhausted && <Mono tone={token.danger}>{firstError(selection.candidates)}</Mono>}

      <div style={{ display: 'flex', gap: token.space2 }}>
        <Button
          tone="primary"
          disabled={!canAccept}
          onClick={onAccept}
          title={canAccept ? 'Keep this variant (Enter)' : 'No variant is ready yet'}
          style={{ flex: 1, justifyContent: 'center' }}
        >
          Keep
        </Button>
        <Button onClick={onDiscard} title="Remove the placeholder; generated files are kept (Esc)">
          Discard
        </Button>
      </div>
    </div>
  );
}

/**
 * One candidate chip.
 *
 * A pending candidate is shown rather than hidden: seeing `3` greyed with its progress is what tells the
 * user that more is coming, and a chip list that grew as results arrived would move the target under a
 * clicking finger.
 */
function CandidateChip({
  candidate,
  selected,
  onSelect,
}: {
  readonly candidate: VariantCandidate;
  readonly selected: boolean;
  readonly onSelect?: (run: JobRunId) => void;
}): ReactNode {
  const failed = candidate.status === 'failed' || candidate.status === 'cancelled';
  const palette = selected
    ? { bg: 'rgba(155, 140, 255, 0.18)', border: token.generated, fg: token.generatedText }
    : failed
      ? { bg: token.surface2, border: token.borderControl, fg: token.danger }
      : candidate.ready
        ? { bg: token.surface2, border: token.generatedDim, fg: token.textMuted }
        : { bg: token.surface2, border: token.borderControl, fg: token.textGhost };

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={chipLabel(candidate)}
      disabled={!candidate.ready}
      onClick={() => onSelect?.(candidate.run)}
      style={{
        position: 'relative',
        minWidth: 34,
        height: token.controlHeightSm,
        padding: `0 ${token.space2}`,
        borderRadius: token.radiusControl,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.fg,
        font: token.textValue,
        cursor: candidate.ready ? 'pointer' : 'default',
        overflow: 'hidden',
      }}
    >
      {candidate.progress !== undefined && !candidate.ready && !failed && (
        // A fill rather than a spinner: it reads at 34 px and shows how far along the run is, which is what
        // decides whether waiting is worth it.
        <span
          role="presentation"
          style={{
            position: 'absolute',
            inset: 0,
            width: `${Math.round(Math.min(1, Math.max(0, candidate.progress)) * 100)}%`,
            background: 'rgba(155, 140, 255, 0.22)',
          }}
        />
      )}
      <span style={{ position: 'relative' }}>{failed ? '×' : candidate.ordinal}</span>
    </button>
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
    <button
      type="button"
      aria-label={`${selection.label} placeholder`}
      aria-pressed={selected}
      onClick={onClick}
      style={{
        position: 'absolute',
        left,
        width: Math.max(2, width),
        height,
        top: 0,
        display: 'flex',
        alignItems: 'center',
        gap: token.space2,
        padding: `0 ${token.space2}`,
        borderRadius: token.radiusInset,
        background: 'rgba(155, 140, 255, 0.10)',
        // Dashed while the length is provisional: a solid edge would claim a precision the manifest does
        // not have, and the clip is about to change length.
        //
        // Longhands rather than the `border` shorthand: a shorthand carrying a `var()` colour is dropped
        // wholesale by stricter CSS parsers, and losing the edge would erase the provisional signal.
        borderWidth: selected ? 2 : 1,
        borderStyle: provisional ? 'dashed' : 'solid',
        borderColor: selected ? token.generated : token.generatedDim,
        color: token.generatedText,
        font: token.textClip,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <Badge tone="generated">{`${selection.readyCount}/${selection.totalCount}`}</Badge>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{selection.label}</span>
    </button>
  );
}
