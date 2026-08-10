import {
  type Clip,
  type ClipId,
  type TimelineDocument,
  clipSource,
  isVisualClip,
  trackClips,
} from '@nos/core';
import { type SourceBoundsResolver } from './clip-ops.js';

/**
 * Clips that ask for more material than their source holds.
 *
 * Trimming is already guarded: `trimClip` refuses to pull an edge past the end of the file and says how
 * many frames were missing. But a *document* can hold such a clip anyway, and nothing said so —
 * whereupon the clip runs past its own media and the frame shows whatever the decoder has left, which is
 * black or a held frame depending on the source. Silent, and indistinguishable from a shot that was
 * meant to end on black.
 *
 * There are three ordinary ways to get one, and none of them goes through a trim:
 *
 * - A hand-written or generated `project.json`. This is how it was found: an edit built from four-second
 *   beds asked for five-second shots, thirty times, and the application drew it without complaint.
 * - A **relink** to a shorter file. The clip keeps its length; the new source may be a different take.
 * - A source **replaced on disk** by something shorter, which the watcher reports as a change and not as
 *   a problem.
 *
 * Reported rather than repaired. Shortening the clip would be an edit nobody asked for, and one that
 * cannot be undone from a state the user never saw — the same reason a collision is refused rather than
 * resolved by displacing a neighbour.
 */

export interface SourceOverrun {
  readonly clip: ClipId;
  readonly label: string;
  /** Frames the clip shows for which the source has no material. Always positive. */
  readonly missing: number;
  /** What the source actually holds, so a message can offer the length that would fit. */
  readonly available: number;
}

/**
 * How many frames a clip asks for beyond its source, or `0` when it fits.
 *
 * `0` for anything with no source to outrun — a title has no file behind it — and `0` when the resolver
 * cannot answer, which is the same rule the trims follow: an unprobed source is not a broken one, and
 * warning about every clip until the probes land would train the user to ignore the warning.
 *
 * Retiming is honoured. A clip at 0.5× consumes half a frame of source per frame of timeline, so the
 * material a slow shot needs is its length *times its speed factor* — reading the span alone would
 * report an overrun on every slowed clip in a project.
 */
export function missingSourceFrames(clip: Clip, sources: SourceBoundsResolver): number {
  const source = clipSource(clip);
  if (source === undefined) return 0;

  const bounds = sources.boundsFor(clip);
  if (bounds === undefined) return 0;

  // A still has one frame and is meant to be held for as long as the clip lasts, which is the whole
  // point of a still. Only moving pictures can run out.
  if (clip.kind === 'image') return 0;

  const consumed = Math.ceil(clip.span.duration * speedOf(clip));
  const available = Math.max(0, bounds.totalFrames - source.sourceIn);
  return Math.max(0, consumed - available);
}

/**
 * Every clip in the document that outruns its source, in timeline order.
 *
 * Sorted by where it happens rather than by how bad it is: a user fixing these works through the
 * sequence, and the first one they meet is the first one that matters.
 */
export function clipsPastTheirSource(
  document: TimelineDocument,
  sources: SourceBoundsResolver,
): readonly SourceOverrun[] {
  const found: SourceOverrun[] = [];

  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      const missing = missingSourceFrames(clip, sources);
      if (missing === 0) continue;

      const bounds = sources.boundsFor(clip);
      const source = clipSource(clip);
      found.push({
        clip: clip.id,
        label: clip.label,
        missing,
        available: Math.max(0, (bounds?.totalFrames ?? 0) - (source?.sourceIn ?? 0)),
      });
    }
  }

  return found.sort((left, right) => startOf(document, left.clip) - startOf(document, right.clip));
}

/**
 * One line about the whole document, or nothing when every clip fits.
 *
 * Names the first offender and counts the rest, which is the rule the shader-error readout already
 * follows: the count alone is the one thing the user can see for themselves, and fixing the first is
 * usually what makes the others make sense.
 */
export function describeSourceOverruns(overruns: readonly SourceOverrun[]): string | undefined {
  const first = overruns[0];
  if (first === undefined) return undefined;

  const one = `${first.label} runs ${first.missing} frame${first.missing === 1 ? '' : 's'} past its source`;
  return overruns.length === 1 ? one : `${one} · and ${overruns.length - 1} more`;
}

function speedOf(clip: Clip): number {
  if (!isVisualClip(clip) && clip.kind !== 'audio') return 1;
  const factor = 'speed' in clip ? clip.speed?.factor : undefined;
  // A zero or negative factor consumes nothing rather than dividing by it; the document should not
  // hold one, and answering `1` here would invent an overrun for a clip that has a different problem.
  return factor === undefined || factor <= 0 ? 1 : factor;
}

function startOf(document: TimelineDocument, id: ClipId): number {
  for (const track of document.sequence.tracks) {
    for (const clip of trackClips(track)) {
      if (clip.id === id) return clip.span.start;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}
