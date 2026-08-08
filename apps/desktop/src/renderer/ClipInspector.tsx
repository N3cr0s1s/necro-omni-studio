import { type ReactNode, useMemo, useState } from 'react';
import {
  type Clip,
  type ClipId,
  type EffectInstance,
  type EffectInstanceId,
  type TimelineDocument,
  animatedNumber,
  effectInstanceId,
  frameIndex,
  isAnimated,
  keyframeId,
  keyframeCount,
  locateClip,
} from '@nos/core';
import { type EffectRegistry, defaultParams, describeEntryProblem } from '@nos/effects';
import { addTransition, describeTransitionError, removeTransition, transitionsOf } from '@nos/editing';
import { type EffectStackEntry, Button, EffectStack, Mono, SectionCaption } from '@nos/ui';
import { token } from '@nos/ui';

/**
 * The clip inspector.
 *
 * Two halves, matching mockup `1b`: the effect stack, and the parameters of whichever effect is
 * selected in it. Both are generated from the **effect manifest** — the same rule the generator panel
 * follows, and for the same reason. A shader author adds a JSON file and gets a working parameter
 * panel; nothing here may branch on an effect id.
 *
 * The parameter controls switch over declared *types* only, and `keyframable` is what decides whether a
 * value can be animated. That flag is the manifest's, not this component's: `progress` on a transition
 * is deliberately not keyframable because the engine computes it from the overlap, and a UI that
 * offered to keyframe it would be offering something the compositor will overwrite.
 */

export interface ClipInspectorProps {
  readonly document: TimelineDocument;
  readonly clip?: string | undefined;
  readonly effects: EffectRegistry;
  readonly onChange: (label: string, next: TimelineDocument) => void;
  /** Surfaces a rejected edit, since a transition can legitimately be refused. */
  readonly onReject?: ((reason: string) => void) | undefined;
}

export function ClipInspector({
  document,
  clip,
  effects,
  onChange,
  onReject,
}: ClipInspectorProps): ReactNode {
  const [selected, setSelected] = useState<EffectInstanceId | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  const located = clip === undefined ? undefined : locateClip(document, clip as never);
  if (located === undefined) {
    return (
      <div style={{ padding: 16 }}>
        <Mono tone={token.textFaint}>no clip selected</Mono>
      </div>
    );
  }

  const stack = located.clip.effects;
  const entries = stack.map((instance): EffectStackEntry => {
    const entry = effects.find(instance.effect);
    // The compiler message rather than a generic label: it is the only feedback a shader author gets,
    // and the spec requires it here with its line number rather than swallowed.
    const problem =
      entry !== undefined && entry.status !== 'available' ? describeEntryProblem(entry) : undefined;
    return {
      instance,
      label: effects.manifestFor(instance.effect)?.name ?? instance.effect,
      keyframeCount: countKeyframes(instance),
      ...(problem !== undefined ? { error: problem } : {}),
    };
  });

  const apply = (label: string, next: readonly EffectInstance[]): void => {
    onChange(label, replaceEffects(document, located.clip, next));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, minWidth: 0 }}>
      <Mono tone={token.textFaint}>{located.clip.label}</Mono>

      <EffectStack
        entries={entries}
        {...(selected !== undefined ? { selected } : {})}
        onSelect={setSelected}
        onToggleEnabled={(instance, enabled) =>
          apply(
            enabled ? 'enable effect' : 'disable effect',
            stack.map((entry) => (entry.id === instance ? { ...entry, enabled } : entry)),
          )
        }
        onRemove={(instance) =>
          apply(
            'remove effect',
            stack.filter((entry) => entry.id !== instance),
          )
        }
        onReorder={(from, to) => apply('reorder effects', reorder(stack, from, to))}
        onAdd={() => setAdding((value) => !value)}
      />

      {adding && (
        <EffectPicker
          effects={effects}
          onPick={(effectId) => {
            setAdding(false);
            const manifest = effects.manifestFor(effectId as never);
            const instance: EffectInstance = {
              // Derived from the stack's length rather than a clock or a counter, so the same sequence of
              // actions always produces the same document — which is what makes an undo comparison and a
              // saved file diffable.
              id: effectInstanceId(`${located.clip.id}_fx${stack.length + 1}`),
              effect: effectId as never,
              enabled: true,
              params: toParams(manifest === undefined ? {} : defaultParams(manifest)),
            };
            setSelected(instance.id);
            apply('add effect', [...stack, instance]);
          }}
        />
      )}

      <Transitions
        document={document}
        clip={located.clip}
        effects={effects}
        onChange={onChange}
        {...(onReject !== undefined ? { onReject } : {})}
      />

      {selected !== undefined && (
        <EffectParams
          instance={stack.find((entry) => entry.id === selected)}
          effects={effects}
          onChange={(next) =>
            apply(
              'set effect parameter',
              stack.map((entry) => (entry.id === next.id ? next : entry)),
            )
          }
        />
      )}
    </div>
  );
}

/**
 * Transitions across this clip's cuts.
 *
 * Offered on the clip rather than on the cut because a cut is not a thing the user can select — the
 * clips are. A transition is created against whichever neighbour meets this clip's edge, and the
 * operation refuses with a reason when there is no neighbour or no handles.
 */
function Transitions({
  document,
  clip,
  effects,
  onChange,
  onReject,
}: {
  readonly document: TimelineDocument;
  readonly clip: Clip;
  readonly effects: EffectRegistry;
  readonly onChange: (label: string, next: TimelineDocument) => void;
  readonly onReject?: (reason: string) => void;
}): ReactNode {
  const [duration, setDuration] = useState(DEFAULT_TRANSITION_FRAMES);

  const available = useMemo(
    () =>
      effects
        .entries()
        .filter((entry) => entry.status === 'available' && entry.manifest.category === 'transition'),
    [effects],
  );
  if (clip.kind !== 'video' && clip.kind !== 'image') return null;

  const neighbours = adjacentClips(document, clip.id);
  const existing = transitionsOf(document, clip.id);

  const apply = (effect: string, side: 'before' | 'after'): void => {
    const pair = side === 'before' ? neighbours.before : neighbours.after;
    if (pair === undefined) return;

    const result = addTransition(document, {
      from: side === 'before' ? pair : clip.id,
      to: side === 'before' ? clip.id : pair,
      effect: effect as never,
      durationFrames: duration,
      id: effectInstanceId(`${clip.id}_${side}_transition`),
    });

    if (result.ok) onChange('add transition', result.value);
    else onReject?.(describeTransitionError(result.error));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionCaption>Transitions</SectionCaption>
        <div style={{ flex: 1 }} />
        <input
          type="number"
          aria-label="Transition frames"
          min={2}
          max={120}
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
          style={{
            width: 60,
            height: token.controlHeightSm,
            background: token.surface1,
            border: `1px solid ${token.borderControl}`,
            borderRadius: token.radiusControl,
            color: token.textBright,
            font: token.textValue,
            padding: `0 ${token.space2}`,
          }}
        />
      </div>

      {existing.map((transition) => (
        <div key={transition.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Mono tone={token.accent}>{`${transition.effect} · ${transition.span.duration}f`}</Mono>
          <div style={{ flex: 1 }} />
          <Button
            onClick={() => {
              const result = removeTransition(document, transition.id);
              if (result.ok) onChange('remove transition', result.value);
              else onReject?.(describeTransitionError(result.error));
            }}
            title="Remove this transition and return both clips to the cut"
          >
            ×
          </Button>
        </div>
      ))}

      {available.length === 0 && <Mono tone={token.textGhost}>no transition effects are registered</Mono>}

      {(['before', 'after'] as const).map((side) => {
        const pair = side === 'before' ? neighbours.before : neighbours.after;
        return (
          <div key={side} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <Mono tone={token.textFaint} style={{ width: 44 }}>
              {side}
            </Mono>
            {available.map((entry) => (
              <Button
                key={entry.id}
                disabled={pair === undefined || entry.id === undefined}
                onClick={() => entry.id !== undefined && apply(entry.id, side)}
                title={
                  pair === undefined
                    ? `nothing meets this clip's ${side === 'before' ? 'start' : 'end'}`
                    : `${entry.status === 'available' ? entry.manifest.name : entry.id} across the cut`
                }
              >
                {entry.status === 'available' ? entry.manifest.name : entry.id}
              </Button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** The clips that meet this one's edges, which are the only ones a transition can join. */
function adjacentClips(document: TimelineDocument, id: string): { before?: ClipId; after?: ClipId } {
  const located = locateClip(document, id as never);
  if (located === undefined) return {};

  const span = located.clip.span;
  const clips = located.track.clips as readonly Clip[];
  const before = clips.find((entry) => entry.span.start + entry.span.duration === span.start);
  const after = clips.find((entry) => entry.span.start === span.start + span.duration);

  return {
    ...(before !== undefined ? { before: before.id } : {}),
    ...(after !== undefined ? { after: after.id } : {}),
  };
}

/** Twelve frames: a little under half a second, the length a dissolve reads as deliberate. */
export const DEFAULT_TRANSITION_FRAMES = 12;

/**
 * The effects that can be added.
 *
 * Every registered effect, including the unavailable ones with their reason — the same rule the
 * generator registry follows. An effect that silently vanished from this list because its shader failed
 * to compile would be indistinguishable from one that was never installed.
 */
function EffectPicker({
  effects,
  onPick,
}: {
  readonly effects: EffectRegistry;
  readonly onPick: (effect: string) => void;
}): ReactNode {
  // Every entry, not only the usable ones. An effect that vanished from this list because its shader
  // failed to compile would be indistinguishable from one that was never installed.
  const available = useMemo(() => effects.entries(), [effects]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <SectionCaption>Add effect</SectionCaption>
      {available.map((entry, index) => (
        <Button
          key={entry.id ?? `invalid-${index}`}
          disabled={entry.status !== 'available' || entry.id === undefined}
          onClick={() => entry.id !== undefined && onPick(entry.id)}
          title={entry.status === 'available' ? entry.manifest.name : describeEntryProblem(entry)}
          style={{ justifyContent: 'flex-start' }}
        >
          {entry.status === 'available' ? entry.manifest.name : (entry.id ?? 'a broken manifest')}
        </Button>
      ))}
      {available.length === 0 && <Mono tone={token.textGhost}>no effects are registered</Mono>}
    </div>
  );
}

/**
 * The selected effect's parameters.
 *
 * Rendered from the manifest's declarations, switching over declared types only. A keyframable parameter
 * that is currently animated is shown as such and left read-only here — its values belong to the
 * keyframe lane, and editing one in two places would need a rule about which wins.
 */
function EffectParams({
  instance,
  effects,
  onChange,
}: {
  readonly instance: EffectInstance | undefined;
  readonly effects: EffectRegistry;
  readonly onChange: (next: EffectInstance) => void;
}): ReactNode {
  if (instance === undefined) return null;

  const manifest = effects.manifestFor(instance.effect);
  const declared = manifest?.params ?? [];
  if (declared.length === 0) {
    return <Mono tone={token.textGhost}>this effect declares no parameters</Mono>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionCaption>{manifest?.name ?? instance.effect}</SectionCaption>
      {declared.map((param) => {
        const value = instance.params[param.key];
        const animated = value !== undefined && isAnimated(value as never);

        return (
          <label key={param.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ font: token.textLabel, color: token.textSoft }}>
              {param.key}
              {animated ? ' · animated' : ''}
            </span>

            {param.keyframable === true && (
              // Animating is an explicit act. A parameter silently becoming keyframed on first edit
              // would surprise anyone who only meant to change its value once.
              <Button
                onClick={() =>
                  onChange({
                    ...instance,
                    params: {
                      ...instance.params,
                      [param.key]: animated
                        ? constant(readNumber(value, param.default))
                        : animatedNumber([
                            {
                              id: keyframeId(`${instance.id}_${param.key}_0`),
                              frame: frameIndex(0),
                              value: readNumber(value, param.default),
                              ease: 'linear',
                            },
                          ]),
                    },
                  })
                }
                title={animated ? 'Return this to a constant value' : 'Animate this with keyframes'}
                style={{ alignSelf: 'flex-start' }}
              >
                {animated ? 'un-animate' : 'animate'}
              </Button>
            )}

            {param.type === 'bool' ? (
              <Button
                tone={readNumber(value, param.default) >= 0.5 ? 'active' : 'default'}
                disabled={animated}
                onClick={() =>
                  onChange({
                    ...instance,
                    params: {
                      ...instance.params,
                      [param.key]: constant(readNumber(value, param.default) >= 0.5 ? 0 : 1),
                    },
                  })
                }
                style={{ alignSelf: 'flex-start' }}
              >
                {readNumber(value, param.default) >= 0.5 ? 'on' : 'off'}
              </Button>
            ) : (
              <input
                type="range"
                aria-label={param.key}
                disabled={animated}
                min={param.min ?? 0}
                max={param.max ?? 1}
                step={(param.max ?? 1) - (param.min ?? 0) > 4 ? 1 : 0.01}
                value={readNumber(value, param.default)}
                onChange={(event) =>
                  onChange({
                    ...instance,
                    params: { ...instance.params, [param.key]: constant(Number(event.target.value)) },
                  })
                }
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

function constant(value: number): EffectInstance['params'][string] {
  return { kind: 'static', value } as unknown as EffectInstance['params'][string];
}

/**
 * The manifest's defaults as document parameter values.
 *
 * `defaultParams` speaks the manifest's language — plain numbers, booleans and vectors — while a clip
 * stores animatables. One conversion, here, rather than a document model that accepts both.
 */
function toParams(
  defaults: Readonly<Record<string, number | boolean | readonly number[]>>,
): EffectInstance['params'] {
  const params: Record<string, EffectInstance['params'][string]> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'number') params[key] = constant(value);
    else if (typeof value === 'boolean') params[key] = constant(value ? 1 : 0);
    else params[key] = { kind: 'static', value } as unknown as EffectInstance['params'][string];
  }
  return params;
}

function readNumber(value: unknown, fallback: number | boolean | readonly number[] | undefined): number {
  if (typeof value === 'number') return value;
  if (value !== null && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === 'number') return inner;
  }
  if (typeof fallback === 'number') return fallback;
  if (typeof fallback === 'boolean') return fallback ? 1 : 0;
  // A vector default has no single number to show on a slider; the control is a placeholder until
  // vector editing exists, and zero is the honest reading rather than an arbitrary component.
  return 0;
}

function countKeyframes(instance: EffectInstance): number {
  let total = 0;
  for (const value of Object.values(instance.params)) {
    if (value !== null && typeof value === 'object' && 'keyframes' in value) {
      total += keyframeCount(value as never);
    }
  }
  return total;
}

function reorder(stack: readonly EffectInstance[], from: number, to: number): readonly EffectInstance[] {
  const next = [...stack];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return stack;
  next.splice(to, 0, moved);
  return next;
}

function replaceEffects(
  document: TimelineDocument,
  clip: Clip,
  effects: readonly EffectInstance[],
): TimelineDocument {
  return {
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((entry) => (entry.id === clip.id ? { ...entry, effects } : entry)),
      })) as TimelineDocument['sequence']['tracks'],
    },
  };
}
