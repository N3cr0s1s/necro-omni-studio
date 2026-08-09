import { useCallback, useMemo, useState } from 'react';
import {
  type AnimatableNumber,
  type BezierEase,
  type Clip,
  type ClipId,
  type ClipTransform,
  type Easing,
  type FrameIndex,
  type Keyframe,
  type KeyframeId,
  type TimelineDocument,
  addKeyframeAt,
  cycleKeyframeEasing,
  editKeyframe,
  frameIndex,
  isAnimated,
  locateClip,
  ok,
  removeKeyframe,
} from '@nos/core';
import { updateClip } from '@nos/editing';
import { type EffectRegistry } from '@nos/effects';
import {
  type TimelineLaneRow,
  type TimelineViewport,
  KEYFRAME_LANE_HEIGHT,
  KEYFRAME_LANE_HEIGHTS,
  KeyframeLane,
} from '@nos/ui';

/**
 * Keyframe lanes for the selected clip.
 *
 * The spec's §6.4: opening a clip gives one lane per animated parameter, markers drag horizontally, and
 * **one drag is one undo step**. That last rule is why a drag holds a preview document and commits once
 * on release, exactly as clip dragging does — a commit per pointer move would fill the history with
 * hundreds of entries and make undo useless.
 *
 * Keyframe positions are **clip-relative**, which is what lets a clip be moved or split without its
 * animation drifting. The lane converts to absolute frames for drawing; nothing else needs to know.
 *
 * The animation shown here is the *only* animation: presets generate keyframes rather than hiding a
 * curve behind a name, so what a preset produced can be edited like anything a user placed by hand.
 */

export interface KeyframeLanesProps {
  readonly document: TimelineDocument;
  readonly clip?: string | undefined;
  readonly effects: EffectRegistry;
  readonly viewport: TimelineViewport;
  readonly playhead: FrameIndex;
  readonly onChange: (label: string, next: TimelineDocument) => void;
}

/**
 * The marker under the cursor of attention, and everything needed to edit it from elsewhere.
 *
 * A keyframe's settings live in two places on purpose: the badge and the readout on the lane, for
 * someone working in the timeline, and the inspector, for someone who wants every property of one
 * marker in front of them at once. The second was missing entirely — clicking a marker selected it
 * and the right column went on showing the clip — and it is the arrangement every editor uses.
 *
 * Carried out of the hook rather than duplicated: the lane and the panel must not each decide what
 * "selected" means, or a marker will be highlighted in one and edited in the other.
 */
export interface SelectedKeyframe {
  readonly id: KeyframeId;
  /** Which parameter it animates, in the same words the lane header uses. */
  readonly label: string;
  readonly keyframe: Keyframe;
  /** Its position on the timeline rather than inside the clip, which is what a user reads. */
  readonly absoluteFrame: FrameIndex;
  /** Whether it is the last marker, whose easing governs nothing. */
  readonly last: boolean;
}

export interface KeyframeLanesResult {
  /** One row per animated parameter, for the timeline to place beside its own headers. */
  readonly rows: readonly TimelineLaneRow[];
  readonly selected: SelectedKeyframe | undefined;
  /** Changes the selected marker. A no-op when nothing is selected. */
  readonly edit: (change: {
    readonly frame?: FrameIndex;
    readonly value?: number;
    readonly ease?: Easing;
    readonly bezier?: BezierEase;
  }) => void;
  readonly remove: () => void;
}

/** The animated variant specifically: a lane only exists for a parameter that has keyframes. */
type AnimatedParam = Extract<AnimatableNumber, { kind: 'animated' }>;

/**
 * One lane.
 *
 * `write` is a closure rather than a discriminant because a lane's parameter lives in one of three
 * places — an effect's params, the clip's transform, or a text clip's `reveal` channel — and every other
 * part of this component treats them identically. Encoding the difference once, where it is created,
 * keeps the drag, the easing cycle and the removal from each needing their own three-way branch.
 */
interface LaneTarget {
  readonly id: string;
  readonly label: string;
  readonly param: AnimatedParam;
  write(document: TimelineDocument, next: AnimatableNumber): TimelineDocument;
  /** Reads this lane's parameter from a document, for a drag that re-applies to the gesture's base. */
  read(document: TimelineDocument): AnimatedParam | undefined;
}

export function useKeyframeLanes({
  document,
  clip,
  effects,
  viewport,
  playhead,
  onChange,
}: KeyframeLanesProps): KeyframeLanesResult {
  const [selected, setSelected] = useState<KeyframeId | undefined>(undefined);
  /**
   * How tall each lane is drawn, by lane id.
   *
   * The vertical zoom the report asks for. Held per lane rather than for all of them: a user
   * magnifies the *one* curve they are shaping, and growing every lane at once would push the tracks
   * below off the screen to look closely at one parameter.
   *
   * Not in the document. It is how closely someone is looking right now, not a property of the
   * animation — persisting it would make a project file remember a zoom and apply it to a different
   * clip a week later, the same reasoning the speed section's "keep the material" switch follows.
   */
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  /**
   * The live drag.
   *
   * `base` is the document as the gesture began — every move re-applies to *that*, so a slow drag lands
   * where a fast one covering the same distance does. `preview` is what the lanes render meanwhile, and
   * it never reaches the store: the whole gesture becomes one history entry on release.
   */
  const [drag, setDrag] = useState<
    { readonly base: TimelineDocument; readonly preview: TimelineDocument } | undefined
  >(undefined);

  const shown = drag?.preview ?? document;
  const located = clip === undefined ? undefined : locateClip(shown, clip as never);
  const clipKey = located?.clip.id;

  const lanes: readonly LaneTarget[] = useMemo(() => {
    if (located === undefined || clipKey === undefined) return [];
    const found: LaneTarget[] = [];

    // The clip's own transform first: a text preset animates position and opacity, and those are the
    // markers a user reaches for after applying one.
    const transform = clipTransformOf(located.clip);
    if (transform !== undefined) {
      for (const channel of TRANSFORM_CHANNELS) {
        const value = transform[channel];
        if (!isAnimated(value)) continue;
        found.push({
          id: `transform-${channel}`,
          label: `transform · ${channel}`,
          param: value,
          write: (target, next) => writeTransform(target, clipKey, channel, next),
          read: (target) => readTransform(target, clipKey, channel),
        });
      }
    }

    // Level and pan. Not transform channels and not effect parameters — they belong to the clip, and
    // an audio clip has no transform at all, so without these an audio fade could be set but never
    // shaped.
    if (located.clip.kind === 'audio') {
      for (const channel of AUDIO_CHANNELS) {
        const value = located.clip[channel];
        if (!isAnimated(value)) continue;
        found.push({
          id: `audio-${channel}`,
          label: `audio · ${channel}`,
          param: value,
          write: (target, next) => writeAudioChannel(target, clipKey, channel, next),
          read: (target) => readAudioChannel(target, clipKey, channel),
        });
      }
    }

    // `reveal` is its own channel, not a transform: typewriter changes the number of visible glyphs,
    // which no transform can express.
    if (
      located.clip.kind === 'text' &&
      located.clip.reveal !== undefined &&
      isAnimated(located.clip.reveal)
    ) {
      found.push({
        id: 'reveal',
        label: 'text · reveal',
        param: located.clip.reveal,
        write: (target, next) => writeReveal(target, clipKey, next),
        read: (target) => readReveal(target, clipKey),
      });
    }

    for (const instance of located.clip.effects) {
      for (const [paramKey, value] of Object.entries(instance.params)) {
        if (!isAnimated(value as AnimatableNumber)) continue;
        found.push({
          id: `${instance.id}-${paramKey}`,
          label: `${effects.manifestFor(instance.effect)?.name ?? instance.effect} · ${paramKey}`,
          param: value as AnimatedParam,
          write: (target, next) => replaceParam(target, clipKey, instance.id, paramKey, next),
          read: (target) => readParam(target, clipKey, instance.id, paramKey),
        });
      }
    }

    return found;
  }, [located, clipKey, effects]);

  /** A discrete edit: one action, one history entry. */
  const commit = useCallback(
    (target: LaneTarget, next: AnimatableNumber, label: string): void => {
      onChange(label, target.write(document, next));
    },
    [document, onChange],
  );

  /** The lane holding the selected marker, and the marker itself. */
  const selection = useMemo(() => {
    if (selected === undefined) return undefined;
    for (const target of lanes) {
      const index = target.param.keyframes.findIndex((entry) => entry.id === selected);
      if (index < 0) continue;
      return {
        target,
        keyframe: target.param.keyframes[index]!,
        last: index === target.param.keyframes.length - 1,
      };
    }
    return undefined;
  }, [lanes, selected]);

  const clipStart = located?.clip.span.start;

  const edit = useCallback(
    (change: {
      readonly frame?: FrameIndex;
      readonly value?: number;
      readonly ease?: Easing;
      readonly bezier?: BezierEase;
    }) => {
      if (selection === undefined || clipStart === undefined) return;
      // A frame arrives as a timeline position, because that is what the panel shows; keyframes are
      // stored clip-relative, which is what lets a clip be moved without its animation drifting.
      const relative =
        change.frame === undefined ? undefined : frameIndex(Math.max(0, change.frame - clipStart));
      onChange(
        'edit keyframe',
        selection.target.write(
          document,
          editKeyframe(selection.target.param, selection.keyframe.id, {
            ...(relative === undefined ? {} : { frame: relative }),
            ...(change.value === undefined ? {} : { value: change.value }),
            ...(change.ease === undefined ? {} : { ease: change.ease }),
            ...(change.bezier === undefined ? {} : { bezier: change.bezier }),
          }),
        ),
      );
    },
    [selection, clipStart, document, onChange],
  );

  const remove = useCallback(() => {
    if (selection === undefined) return;
    onChange(
      'remove keyframe',
      selection.target.write(document, removeKeyframe(selection.target.param, selection.keyframe.id)),
    );
    setSelected(undefined);
  }, [selection, document, onChange]);

  const rows: readonly TimelineLaneRow[] = useMemo(() => {
    if (located === undefined || lanes.length === 0) return [];

    const laneRows = lanes.map((target) => ({
      id: target.id,
      label: target.label,
      heightPx: heights.get(target.id) ?? KEYFRAME_LANE_HEIGHT,
      zoom: {
        canGrow: (heights.get(target.id) ?? KEYFRAME_LANE_HEIGHT) !== KEYFRAME_LANE_HEIGHTS.at(-1),
        canShrink: (heights.get(target.id) ?? KEYFRAME_LANE_HEIGHT) !== KEYFRAME_LANE_HEIGHTS[0],
        onZoom: (direction: 1 | -1) => {
          setHeights((current) => {
            const at = KEYFRAME_LANE_HEIGHTS.indexOf(current.get(target.id) ?? KEYFRAME_LANE_HEIGHT);
            const next =
              KEYFRAME_LANE_HEIGHTS[
                Math.min(KEYFRAME_LANE_HEIGHTS.length - 1, Math.max(0, (at < 0 ? 0 : at) + direction))
              ];
            if (next === undefined) return current;
            const updated = new Map(current);
            updated.set(target.id, next);
            return updated;
          });
        },
      },
      body: (
        <KeyframeLane
          label={target.label}
          keyframes={target.param.keyframes}
          clipStart={located.clip.span.start}
          viewport={viewport}
          playhead={playhead}
          heightPx={heights.get(target.id) ?? KEYFRAME_LANE_HEIGHT}
          {...(selected !== undefined ? { selected } : {})}
          onSelectKeyframe={setSelected}
          onDragStart={() => setDrag({ base: document, preview: document })}
          onDragKeyframe={(id, toFrame, toValue) => {
            setDrag((current) => {
              const base = current?.base ?? document;
              const from = locateClip(base, located.clip.id);
              const original = target.read(base);
              if (from === undefined || original === undefined) return current;

              const relative = frameIndex(Math.max(0, toFrame - from.clip.span.start));
              // Both axes in one edit. A drag that wrote the frame and then the value would be two
              // history entries per pointer move once the gesture commits, and the second would be
              // applied to a document the first had already re-sorted.
              return {
                base,
                preview: target.write(
                  base,
                  editKeyframe(original, id, {
                    frame: relative,
                    ...(Number.isFinite(toValue) ? { value: toValue } : {}),
                  }),
                ),
              };
            });
          }}
          onDragEnd={() => {
            // The single history entry for the whole gesture. Everything before this was a preview
            // that never reached the store.
            setDrag((current) => {
              if (current !== undefined) onChange('move keyframe', current.preview);
              return undefined;
            });
          }}
          onCycleEasing={(id) => commit(target, cycleKeyframeEasing(target.param, id), 'change easing')}
          // A discrete edit, so one history entry — unlike a drag, which coalesces. Typing 0.5 and
          // then 0.55 is two decisions, and undo should step back through both.
          onChangeValue={(id, value) =>
            commit(target, editKeyframe(target.param, id, { value }), 'set keyframe value')
          }
          onRemoveKeyframe={(id) => commit(target, removeKeyframe(target.param, id), 'remove keyframe')}
          onAddKeyframe={(atFrame) =>
            commit(
              target,
              addKeyframeAt(target.param, frameIndex(Math.max(0, atFrame - located.clip.span.start))),
              'add keyframe',
            )
          }
        />
      ),
    }));

    // A row of its own rather than a paragraph after the lanes, because everything under a track has
    // to be a row: anything else in that column has no header beside it and pushes the two columns
    // out of step, which is the whole of what was wrong here.
    return [
      ...laneRows,
      {
        id: 'lane-hint',
        label: '',
        heightPx: HINT_ROW_HEIGHT,
        body: (
          <p className="px-2 font-mono text-[11px] leading-[18px] text-muted-foreground">
            double-click a lane to add a keyframe · click a marker´s badge to cycle its easing
          </p>
        ),
      },
    ];
  }, [lanes, located, viewport, playhead, selected, document, onChange, commit, heights]);

  return {
    rows,
    selected:
      selection === undefined || clipStart === undefined
        ? undefined
        : {
            id: selection.keyframe.id,
            label: selection.target.label,
            keyframe: selection.keyframe,
            absoluteFrame: frameIndex(clipStart + selection.keyframe.frame),
            last: selection.last,
          },
    edit,
    remove,
  };
}

/** The hint row's height. One line of the smallest type the panel uses, plus its leading. */
const HINT_ROW_HEIGHT = 18;

/** Transform channels a keyframe lane can show. `rotation` included: a title can spin. */
const TRANSFORM_CHANNELS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

type TransformChannel = (typeof TRANSFORM_CHANNELS)[number];

const AUDIO_CHANNELS = ['gain', 'pan'] as const;

type AudioChannel = (typeof AUDIO_CHANNELS)[number];

function clipTransformOf(clip: Clip): ClipTransform | undefined {
  return clip.kind === 'audio' ? undefined : clip.transform;
}

/**
 * Writes one clip back into the document.
 *
 * Through `@nos/editing`'s own `updateClip`, which is what this used to hand-roll — and the hand-rolled
 * version was missing two things that only a shared helper keeps you from missing.
 *
 * It **rebuilt every track**, so a keyframe edit copied all three tracks and every clip array on them.
 * The editing layer's rule is that only the changed root-to-leaf path is rebuilt and untouched tracks
 * stay by reference, which is precisely what makes snapshot undo cost pointers rather than a copy of
 * the project. A test asserts it for a split; nothing asserted it here, and it was not true.
 *
 * And it **did not check the lock**, so a locked track protected its clips from every gesture on the
 * timeline and none of the ones in a keyframe lane. A refusal returns the document unchanged, which
 * is what a locked track means — the marker snaps back, because the lane is drawn from the document.
 */
function mapClip(
  document: TimelineDocument,
  clipKey: string,
  change: (clip: Clip) => Clip,
): TimelineDocument {
  const updated = updateClip(document, clipKey as ClipId, (clip) => ok(change(clip)));
  return updated.ok ? updated.value : document;
}

function writeTransform(
  document: TimelineDocument,
  clipKey: string,
  channel: TransformChannel,
  value: AnimatableNumber,
): TimelineDocument {
  return mapClip(document, clipKey, (clip) =>
    clip.kind === 'audio' ? clip : { ...clip, transform: { ...clip.transform, [channel]: value } },
  );
}

function readTransform(
  document: TimelineDocument,
  clipKey: string,
  channel: TransformChannel,
): AnimatedParam | undefined {
  const located = locateClip(document, clipKey as never);
  const transform = located === undefined ? undefined : clipTransformOf(located.clip);
  const value = transform?.[channel];
  return value !== undefined && isAnimated(value) ? value : undefined;
}

function writeAudioChannel(
  document: TimelineDocument,
  clipKey: string,
  channel: AudioChannel,
  value: AnimatableNumber,
): TimelineDocument {
  return mapClip(document, clipKey, (clip) => (clip.kind === 'audio' ? { ...clip, [channel]: value } : clip));
}

function readAudioChannel(
  document: TimelineDocument,
  clipKey: string,
  channel: AudioChannel,
): AnimatedParam | undefined {
  const located = locateClip(document, clipKey as never);
  const clip = located?.clip;
  if (clip === undefined || clip.kind !== 'audio') return undefined;
  const value = clip[channel];
  return isAnimated(value) ? value : undefined;
}

function writeReveal(document: TimelineDocument, clipKey: string, value: AnimatableNumber): TimelineDocument {
  return mapClip(document, clipKey, (clip) => (clip.kind === 'text' ? { ...clip, reveal: value } : clip));
}

function readReveal(document: TimelineDocument, clipKey: string): AnimatedParam | undefined {
  const located = locateClip(document, clipKey as never);
  const clip = located?.clip;
  if (clip === undefined || clip.kind !== 'text' || clip.reveal === undefined) return undefined;
  return isAnimated(clip.reveal) ? clip.reveal : undefined;
}

function readParam(
  document: TimelineDocument,
  clipKey: string,
  instanceId: string,
  paramKey: string,
): AnimatedParam | undefined {
  const located = locateClip(document, clipKey as never);
  const value = located?.clip.effects.find((entry) => entry.id === instanceId)?.params[paramKey];
  return value !== undefined && isAnimated(value as AnimatableNumber) ? (value as AnimatedParam) : undefined;
}

function replaceParam(
  document: TimelineDocument,
  clipId: string,
  instanceId: string,
  paramKey: string,
  value: AnimatableNumber,
): TimelineDocument {
  return {
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((entry) =>
          entry.id !== clipId
            ? entry
            : {
                ...entry,
                effects: entry.effects.map((instance) =>
                  instance.id !== instanceId
                    ? instance
                    : { ...instance, params: { ...instance.params, [paramKey]: value } },
                ),
              },
        ),
      })) as TimelineDocument['sequence']['tracks'],
    },
  };
}
