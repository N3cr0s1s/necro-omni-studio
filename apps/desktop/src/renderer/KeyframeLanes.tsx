import { type ReactNode, useCallback, useState } from 'react';
import {
  type AnimatableNumber,
  type EffectInstance,
  type FrameIndex,
  type Keyframe,
  type KeyframeId,
  type TimelineDocument,
  EASINGS,
  animatedNumber,
  evaluateAt,
  frameIndex,
  isAnimated,
  keyframeId,
  locateClip,
} from '@nos/core';
import { type EffectRegistry } from '@nos/effects';
import { type TimelineViewport, KeyframeLane, Mono } from '@nos/ui';
import { token } from '@nos/ui';

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

interface LaneTarget {
  readonly instance: EffectInstance;
  readonly paramKey: string;
  readonly label: string;
  readonly param: AnimatedParam;
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
  const lanes: readonly LaneTarget[] =
    located === undefined
      ? []
      : located.clip.effects.flatMap((instance) =>
          Object.entries(instance.params)
            .filter(([, value]) => isAnimated(value as AnimatableNumber))
            .map(([paramKey, value]) => ({
              instance,
              paramKey,
              label: `${effects.manifestFor(instance.effect)?.name ?? instance.effect} · ${paramKey}`,
              param: value as AnimatedParam,
            })),
        );

  /** A discrete edit: one action, one history entry. */
  const commit = useCallback(
    (target: LaneTarget, next: AnimatableNumber, label: string): void => {
      if (located === undefined) return;
      onChange(label, replaceParam(document, located.clip.id, target.instance.id, target.paramKey, next));
    },
    [document, located, onChange],
  );

  if (located === undefined || lanes.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderTop: `1px solid ${token.borderSubtle}` }}>
      {lanes.map((target) => (
        <KeyframeLane
          key={`${target.instance.id}-${target.paramKey}`}
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
              if (from === undefined) return current;

              const original = from.clip.effects.find((instance) => instance.id === target.instance.id)
                ?.params[target.paramKey];
              if (original === undefined || !isAnimated(original as AnimatableNumber)) return current;

              const relative = frameIndex(Math.max(0, toFrame - from.clip.span.start));
              const moved = moveKeyframe(original as AnimatedParam, id, relative);
              return {
                base,
                preview: replaceParam(base, from.clip.id, target.instance.id, target.paramKey, moved),
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
          onCycleEasing={(id) => commit(target, cycleEasing(target.param, id), 'change easing')}
          onRemoveKeyframe={(id) => commit(target, removeKeyframe(target.param, id), 'remove keyframe')}
          onAddKeyframe={(atFrame) =>
            commit(
              target,
              addKeyframe(target.param, frameIndex(Math.max(0, atFrame - located.clip.span.start))),
              'add keyframe',
            )
          }
        />
      ))}
      <Mono tone={token.textGhost} style={{ padding: '2px 8px' }}>
        double-click a lane to add a keyframe · click a marker´s badge to cycle its easing
      </Mono>
    </div>
  );
}

/**
 * Moves a keyframe, keeping the list sorted.
 *
 * Sorted because evaluation walks the list in order: an out-of-order keyframe would be skipped by the
 * search and its value silently ignored, which looks like the marker simply not working.
 */
function moveKeyframe(param: AnimatedParam, id: KeyframeId, to: FrameIndex): AnimatableNumber {
  // `animatedNumber` sorts and dedupes, so a drag landing on an occupied frame replaces rather than
  // throwing mid-gesture — which is exactly what that constructor was written for.
  return animatedNumber(
    param.keyframes.map((keyframe) => (keyframe.id === id ? { ...keyframe, frame: to } : keyframe)),
  );
}

function removeKeyframe(param: AnimatedParam, id: KeyframeId): AnimatableNumber {
  const remaining = param.keyframes.filter((keyframe) => keyframe.id !== id);
  // A parameter with one keyframe left is still animated, which is meaningful: it holds that value and
  // the user can add a second. Collapsing to a constant here would quietly discard their easing choice.
  return animatedNumber(remaining);
}

/**
 * Adds a keyframe at a frame, taking the parameter's current value there.
 *
 * The value comes from evaluating the existing curve rather than from a default, so adding a marker in
 * the middle of an animation does not change what the animation does — it only makes that instant
 * editable, which is what a user means by the gesture.
 */
function addKeyframe(param: AnimatedParam, at: FrameIndex): AnimatableNumber {
  if (param.keyframes.some((keyframe) => keyframe.frame === at)) return param;

  const keyframe: Keyframe = {
    id: keyframeId(`kf_${at}`),
    frame: at,
    value: evaluateAt(param, at),
    ease: 'linear',
  };
  return animatedNumber([...param.keyframes, keyframe]);
}

/** Cycles a marker's interpolation through the modes the spec fixes for v1. */
function cycleEasing(param: AnimatedParam, id: KeyframeId): AnimatableNumber {
  return animatedNumber(
    param.keyframes.map((keyframe) => {
      if (keyframe.id !== id) return keyframe;
      const index = EASINGS.indexOf(keyframe.ease);
      return { ...keyframe, ease: EASINGS[(index + 1) % EASINGS.length] ?? 'linear' };
    }),
  );
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
