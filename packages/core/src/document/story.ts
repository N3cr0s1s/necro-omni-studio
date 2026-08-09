import type { AssetPath, StoryBeatId } from './ids.js';
import type { FrameSpan } from '../time/frame-span.js';

/**
 * The story board: what is meant to happen, on the same clock as the cut.
 *
 * Issue #33. A beat says *when* something should happen, *what* it is in prose, and *what it should
 * look and sound like* by pointing at reference material already in the project. It is a plan, not a
 * render — nothing here is composited, exported or mixed.
 *
 * Two reasons it earns a place in the document rather than a side file:
 *
 * - **It is the project's intent**, and intent that lives outside the project is intent that goes
 *   stale the first time someone moves the folder. §4 promises that zipping the folder moves the whole
 *   project, and a beat sheet in someone's notes app breaks that quietly.
 * - **Undo, autosave and crash recovery are already uniform.** Every mutation in this application goes
 *   through the patch engine; a plan stored anywhere else would need its own answer to all three, and
 *   would be the only part of the editor where a mistake could not be taken back.
 *
 * ## Why beats have a span rather than a point
 *
 * A marker says "here"; a beat says "through here". The whole use — describing a shot that runs three
 * seconds, then the one after it — needs a length, and the mockup in the issue shows exactly that:
 * blocks of time carrying a title and a paragraph.
 *
 * ## Why an accent index and not a colour
 *
 * The mockup colours its blocks, and a stored `#3b82f6` would be the one place in this application
 * that names a colour outside the palette — unreadable in a theme it was not chosen for, and the exact
 * mistake the theme audit exists to catch. An accent is an index into the categorical roles the themes
 * already define, so a board coloured under one theme stays legible under all six.
 */

/** How many accents a beat may choose between: the chart roles, which is what they are for. */
export const STORY_ACCENTS = [1, 2, 3, 4, 5] as const;

export type StoryAccent = (typeof STORY_ACCENTS)[number];

/**
 * Reference material attached to a beat.
 *
 * A project-relative path and nothing else: what *kind* of reference it is comes from the file, which
 * `classifyAsset` already answers for the browser and the timeline. Storing a kind here would be a
 * second answer that can disagree with the first — and does, the moment someone replaces a `.png`
 * with a `.mp4` under the same name.
 */
export interface StoryReference {
  readonly asset: AssetPath;
  /** Why it is attached: "the light in this", "the pacing here". Optional; often the file is enough. */
  readonly note?: string;
}

export interface StoryBeat {
  readonly id: StoryBeatId;
  /** When it happens, in project frames — the same clock as every clip. */
  readonly span: FrameSpan;
  /** The one line shown on the block. What the shot *is*. */
  readonly title: string;
  /**
   * What should happen, as markdown.
   *
   * Markdown because §4 already reserves `notes/` for it and the browser already renders it, so a beat
   * written here reads the same as a note written beside it. Prose is the point: this is the text a
   * generator prompt is later written *from*, and a form with fields for camera, subject and mood
   * would decide in advance what a shot is allowed to be about.
   */
  readonly notes: string;
  readonly references: readonly StoryReference[];
  /** Which categorical role draws it. Absent means the first, so an unset beat is not invisible. */
  readonly accent?: StoryAccent;
}

/** The accent a beat is drawn in, resolved. */
export function accentOf(beat: StoryBeat): StoryAccent {
  return beat.accent ?? 1;
}

/**
 * Beats in the order they happen, then by id.
 *
 * Sorted on read rather than kept sorted on write: a beat being *dragged* passes through every
 * position between where it was and where it lands, and a list that reordered itself under the pointer
 * is the one behaviour a timeline must not have. The id breaks ties so two beats starting on the same
 * frame do not swap places between renders.
 */
export function beatsInOrder(beats: readonly StoryBeat[]): readonly StoryBeat[] {
  return [...beats].sort((left, right) => {
    const byStart = (left.span.start as number) - (right.span.start as number);
    return byStart !== 0 ? byStart : (left.id as string).localeCompare(right.id as string);
  });
}

/**
 * The beat covering a frame, or `undefined`.
 *
 * The *last* one when several overlap, matching how the board draws them — later beats paint over
 * earlier ones, so the one under the pointer is the one on top.
 */
export function beatAt(beats: readonly StoryBeat[], frame: number): StoryBeat | undefined {
  let found: StoryBeat | undefined;
  for (const beat of beats) {
    const start = beat.span.start as number;
    const end = start + (beat.span.duration as number);
    if (frame >= start && frame < end) found = beat;
  }
  return found;
}

/**
 * Every asset any beat references, once each, in first-use order.
 *
 * Named apart from the document's own `referencedAssets`, which answers what the *cut* reads. A beat's
 * references are material the cut may never touch — that is the point of a reference — so conflating
 * the two would make "unused" mean something different depending on which one a caller reached for.
 */
export function beatReferences(beats: readonly StoryBeat[]): readonly AssetPath[] {
  const seen = new Set<string>();
  const assets: AssetPath[] = [];

  for (const beat of beatsInOrder(beats)) {
    for (const reference of beat.references) {
      if (seen.has(reference.asset as string)) continue;
      seen.add(reference.asset as string);
      assets.push(reference.asset);
    }
  }

  return assets;
}
