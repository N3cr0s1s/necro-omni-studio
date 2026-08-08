import { type ReactNode, useCallback, useMemo, useState } from 'react';
import {
  type AnimatableNumber,
  type Clip,
  type ClipTransform,
  type FrameIndex,
  type KeyframeId,
  type TimelineDocument,
  addKeyframeAt,
  cycleKeyframeEasing,
  editKeyframe,
  frameIndex,
  isAnimated,
  locateClip,
  removeKeyframe,
} from '@nos/core';
import { type EffectRegistry } from '@nos/effects';
import { type TimelineViewport, KeyframeLane } from '@nos/ui';

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

export function KeyframeLanes({
  document,
  clip,
  effects,
  viewport,
  playhead,
  onChange,
}: KeyframeLanesProps): ReactNode {
  const [selected, setSelected] = useState<KeyframeId | undefined>(undefined);
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

  if (located === undefined || lanes.length === 0) return null;

  return (
    <div className="flex flex-col border-t">
      {lanes.map((target) => (
        <KeyframeLane
          key={target.id}
          label={target.label}
          keyframes={target.param.keyframes}
          clipStart={located.clip.span.start}
          viewport={viewport}
          playhead={playhead}
          {...(selected !== undefined ? { selected } : {})}
          onSelectKeyframe={setSelected}
          onDragStart={() => setDrag({ base: document, preview: document })}
          onDragKeyframe={(id, toFrame) => {
            setDrag((current) => {
              const base = current?.base ?? document;
              const from = locateClip(base, located.clip.id);
              const original = target.read(base);
              if (from === undefined || original === undefined) return current;

              const relative = frameIndex(Math.max(0, toFrame - from.clip.span.start));
              return {
                base,
                preview: target.write(base, editKeyframe(original, id, { frame: relative })),
              };
            });
          }}
          onDragEnd={() => {
            // The single history entry for the whole gesture. Everything before this was a preview that
            // never reached the store.
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
      ))}
      <p className="px-2 py-0.5 font-mono text-xs text-muted-foreground">
        double-click a lane to add a keyframe · click a marker´s badge to cycle its easing
      </p>
    </div>
  );
}

/** Transform channels a keyframe lane can show. `rotation` included: a title can spin. */
const TRANSFORM_CHANNELS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

type TransformChannel = (typeof TRANSFORM_CHANNELS)[number];

const AUDIO_CHANNELS = ['gain', 'pan'] as const;

type AudioChannel = (typeof AUDIO_CHANNELS)[number];

function clipTransformOf(clip: Clip): ClipTransform | undefined {
  return clip.kind === 'audio' ? undefined : clip.transform;
}

function mapClip(
  document: TimelineDocument,
  clipKey: string,
  change: (clip: Clip) => Clip,
): TimelineDocument {
  return {
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((entry) => (entry.id === clipKey ? change(entry as Clip) : entry)),
      })) as TimelineDocument['sequence']['tracks'],
    },
  };
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
