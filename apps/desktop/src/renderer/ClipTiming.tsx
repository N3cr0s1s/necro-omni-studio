import type { ReactNode } from 'react';
import {
  ArrowLeftRightIcon,
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  type LucideIcon,
  MoveHorizontalIcon,
} from 'lucide-react';
import {
  type Clip,
  type FrameRate,
  type TimelineDocument,
  clipSource,
  convertFrames,
  endExclusive,
  formatFrames,
  frameIndex,
} from '@nos/core';
import { eligibleTracksFor, moveClipsBy, slipClip, trimClipEnd, withLinkedClips } from '@nos/editing';
import { NumberField } from '@nos/ui';
import { describeEditError } from './edit-errors.js';

/**
 * Where a clip is, how long it is, and which part of its source it shows.
 *
 * The spec's §6.1 asks for **frame-accurate** cutting and trimming, and until now the only way to set
 * any of it was to drag. A drag cannot reliably land on frame 120, and — worse — nothing on screen
 * said which frame it had landed on, so there was no way to check either. An editor that can only be
 * driven by pointer is not frame-accurate however precise its document model is.
 *
 * ## What each field means
 *
 * The four values are not four independent numbers; they are two pairs, and which one a change is
 * *about* decides what happens to the others.
 *
 * - **Start** moves the clip. Duration and source are untouched — the same gesture as dragging its
 *   body, and it takes any linked partner with it for the same reason a drag does.
 * - **Duration** trims the tail. The start stays where it is, so the clip grows or shrinks to the
 *   right, which is what dragging the right edge does.
 * - **Source in** slips. The clip stays exactly where it is on the timeline and its content moves
 *   inside it — the spec's *csúsztatás*, reachable until now only by holding `Alt` while dragging,
 *   which nothing on screen suggested.
 * - **End** is derived and read-only. It is start plus duration, and offering it as a fifth field
 *   would be a second way to say "duration" that has to agree with the first.
 *
 * Every one of them goes through the same operations the drags do, so a typed edit and a dragged one
 * are the same edit — including the refusals. Typing a start that would overlap a neighbour is
 * rejected exactly as dragging there is.
 */

export interface ClipTimingProps {
  readonly document: TimelineDocument;
  readonly clip: Clip;
  readonly onChange: (label: string, next: TimelineDocument) => void;
  /** Surfaces a refusal, since a collision or a locked track legitimately rejects one of these. */
  readonly onReject?: ((reason: string) => void) | undefined;
}

export function ClipTiming({ document, clip, onChange, onReject }: ClipTimingProps): ReactNode {
  const { span } = clip;
  const source = clipSource(clip);
  const end = endExclusive(span);

  const commit = (label: string, result: ReturnType<typeof trimClipEnd>): void => {
    if (result.ok) onChange(label, result.value);
    else onReject?.(describeEditError(result.error));
  };

  return (
    <section aria-label="Timing" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Timing</span>
        {/* The timecode of the span, so the frame numbers below have something to be read against —
            an editor thinks in both and converting in your head is not a feature. */}
        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
          {formatFrames(span.start, document.frameRate)} – {formatFrames(end, document.frameRate)}
        </span>
      </div>

      <Row
        label="start"
        icon={ArrowRightToLineIcon}
        value={span.start}
        rate={document.frameRate}
        onCommit={(next) => {
          // Through the many-clip move so a linked pair travels together, which is what dragging the
          // body does. Moving a video and leaving its audio behind is the one outcome nobody wants.
          const group = withLinkedClips(document, [clip.id]);
          const moved = moveClipsBy(document, group, next - span.start, 0, (candidate) =>
            eligibleTracksFor(document.sequence.tracks, candidate),
          );
          if (moved.ok) onChange('set clip start', moved.value.document);
          else onReject?.(describeEditError(moved.error));
        }}
      />

      <Row
        label="duration"
        icon={MoveHorizontalIcon}
        value={span.duration}
        rate={document.frameRate}
        min={1}
        onCommit={(next) => commit('set clip duration', trimClipEnd(document, clip.id, next - span.duration))}
      />

      {source !== undefined && (
        <Row
          label="source in"
          icon={ArrowLeftRightIcon}
          value={source.sourceIn}
          rate={source.sourceRate}
          onCommit={(next) => {
            /*
             * `slipClip` takes its delta in **project** frames and adds it to a source-frame position,
             * converting on the way. This field edits the source position directly, so the difference
             * has to be converted back the other way before handing it over — at matching rates that
             * is the identity, and at 24-into-30 it is the difference between landing on the frame
             * asked for and landing near it.
             */
            const wanted = frameIndex(Math.abs(next - source.sourceIn));
            const inProjectFrames = convertFrames(wanted, source.sourceRate, document.frameRate);
            const delta = next >= source.sourceIn ? inProjectFrames : -inProjectFrames;
            commit('slip clip', slipClip(document, clip.id, delta));
          }}
        />
      )}

      <div className="flex items-center gap-2">
        <ArrowLeftToLineIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        <span className="w-14 text-xs text-muted-foreground">end</span>
        {/* Read-only: it is start plus duration, and a fifth field would be a second way to say
            "duration" that has to agree with the first. */}
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{end}</span>
      </div>
    </section>
  );
}

/** One frame-valued field, with the timecode it corresponds to beside it. */
function Row({
  label,
  icon: Icon,
  value,
  rate,
  min,
  onCommit,
}: {
  readonly label: string;
  /**
   * What this row does to the clip, as a glyph.
   *
   * Four rows of frame numbers read as one block, and the difference between them is precisely the
   * thing a user has to get right: moving, trimming and slipping look identical as labels and are
   * three different edits.
   */
  readonly icon: LucideIcon;
  readonly value: number;
  readonly rate: FrameRate;
  readonly min?: number;
  readonly onCommit: (next: number) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-14 text-xs text-muted-foreground">{label}</span>
      <NumberField
        aria-label={label}
        value={value}
        step={1}
        {...(min !== undefined ? { min } : {})}
        // Commits on Enter and on blur rather than per keystroke: typing `120` passes through `1` and
        // `12`, and a clip that jumped to frame 1 on the way would be an edit nobody asked for.
        onCommit={(next) => {
          const whole = Math.round(next);
          if (whole !== value) onCommit(whole);
        }}
        className="w-20 font-mono tabular-nums"
      />
      <span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
        {formatFrames(frameIndex(Math.max(0, value)), rate)}
      </span>
    </div>
  );
}
