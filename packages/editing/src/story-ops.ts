import {
  type AssetPath,
  type FrameIndex,
  type StoryAccent,
  type StoryBeat,
  type StoryBeatId,
  type StoryReference,
  type TimelineDocument,
  frameIndex,
  spanFromBounds,
  storyBeatId,
} from '@nos/core';

/**
 * Editing the story board, per issue #33.
 *
 * Document transforms like every other operation here: pure, total, and returning a new document. That
 * is what puts the board under the same undo, autosave and crash recovery as the cut, rather than
 * giving a planning feature its own worse answer to all three.
 *
 * ## No `Result`
 *
 * Unlike a clip move, none of these can be *refused*. Beats may overlap — two ideas about the same
 * three seconds is a normal state for a plan, and the mockup in the issue shows blocks abutting and
 * running together. There is no collision to report, so a `Result` here would be a return type whose
 * error branch never happened, which readers learn to ignore.
 */

/** The length a beat gets when nothing says otherwise: two seconds at the project rate. */
export const DEFAULT_BEAT_SECONDS = 2;

/**
 * Adds a beat starting at a frame.
 *
 * Ids carry the frame they were made at, so two beats added at different points never collide and one
 * added twice at the same point does — which the caller resolves by suffixing, exactly as generated
 * clips do. A random id would be simpler and would make the same document serialize differently on
 * every run, which is unreadable in version control.
 */
export function addBeat(
  document: TimelineDocument,
  at: FrameIndex,
  options: { readonly seconds?: number; readonly title?: string } = {},
): TimelineDocument {
  const rate = document.frameRate.value.numerator / document.frameRate.value.denominator;
  const length = Math.max(1, Math.round((options.seconds ?? DEFAULT_BEAT_SECONDS) * rate));

  const taken = new Set(document.story.map((beat) => beat.id as string));
  let id = `beat_${at as number}`;
  for (let attempt = 2; taken.has(id); attempt += 1) id = `beat_${at as number}_${attempt}`;

  const beat: StoryBeat = {
    id: storyBeatId(id),
    span: spanFromBounds(at, frameIndex((at as number) + length)),
    title: options.title ?? '',
    notes: '',
    references: [],
  };

  return { ...document, story: [...document.story, beat] };
}

export function removeBeat(document: TimelineDocument, id: StoryBeatId): TimelineDocument {
  return { ...document, story: document.story.filter((beat) => beat.id !== id) };
}

/**
 * What may be changed about a beat.
 *
 * A change-object, following the rule this codebase uses everywhere: absent leaves a field alone.
 * `accent: null` clears it back to the default, because "no accent" is a state a user can choose and
 * `undefined` already means "not mentioned".
 */
export interface BeatChanges {
  readonly title?: string;
  readonly notes?: string;
  readonly accent?: StoryAccent | null;
  readonly span?: { readonly start: FrameIndex; readonly end: FrameIndex };
}

export function editBeat(
  document: TimelineDocument,
  id: StoryBeatId,
  changes: BeatChanges,
): TimelineDocument {
  return {
    ...document,
    story: document.story.map((beat) => (beat.id === id ? applyChanges(beat, changes) : beat)),
  };
}

function applyChanges(beat: StoryBeat, changes: BeatChanges): StoryBeat {
  const { accent: _current, ...rest } = beat;

  return {
    ...rest,
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
    ...(changes.span !== undefined
      ? {
          // At least one frame. A beat of zero length is invisible on the board and impossible to grab
          // back, so the control should not be able to produce one.
          span: spanFromBounds(
            changes.span.start,
            frameIndex(Math.max((changes.span.start as number) + 1, changes.span.end as number)),
          ),
        }
      : {}),
    // Written only when it survives: `null` clears, absent leaves, and an absent field is how the
    // document says "the default" — so a cleared accent must not become `accent: undefined` on disk.
    ...(changes.accent === null
      ? {}
      : changes.accent !== undefined
        ? { accent: changes.accent }
        : beat.accent !== undefined
          ? { accent: beat.accent }
          : {}),
  };
}

/**
 * Moves a beat without changing its length.
 *
 * Clamped at zero rather than refused: dragging a beat off the left of the board is a gesture with an
 * obvious intent, and stopping at the start is what every other drag in this application does.
 */
export function moveBeat(document: TimelineDocument, id: StoryBeatId, to: FrameIndex): TimelineDocument {
  return {
    ...document,
    story: document.story.map((beat) => {
      if (beat.id !== id) return beat;
      const start = Math.max(0, to as number);
      return {
        ...beat,
        span: spanFromBounds(frameIndex(start), frameIndex(start + (beat.span.duration as number))),
      };
    }),
  };
}

/**
 * Attaches a reference, or leaves the beat alone if it already has that one.
 *
 * Silently, because attaching the same image twice is a user repeating themselves rather than making a
 * mistake, and two identical rows in the list would be the only visible result.
 */
export function attachReference(
  document: TimelineDocument,
  id: StoryBeatId,
  asset: AssetPath,
  note?: string,
): TimelineDocument {
  return {
    ...document,
    story: document.story.map((beat) => {
      if (beat.id !== id) return beat;
      if (beat.references.some((reference) => reference.asset === asset)) return beat;

      const reference: StoryReference = { asset, ...(note !== undefined ? { note } : {}) };
      return { ...beat, references: [...beat.references, reference] };
    }),
  };
}

export function detachReference(
  document: TimelineDocument,
  id: StoryBeatId,
  asset: AssetPath,
): TimelineDocument {
  return {
    ...document,
    story: document.story.map((beat) =>
      beat.id === id
        ? { ...beat, references: beat.references.filter((reference) => reference.asset !== asset) }
        : beat,
    ),
  };
}
