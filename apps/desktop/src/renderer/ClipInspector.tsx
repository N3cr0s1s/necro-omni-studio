import { type ReactNode, useMemo, useState } from 'react';
import {
  type AnimatableNumber,
  type Clip,
  type ClipId,
  type EffectId,
  type EffectInstance,
  type EffectInstanceId,
  type StaticValue,
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
import {
  addTransition,
  describeTransitionError,
  removeTransition,
  setTransitionParams,
  transitionsOf,
} from '@nos/editing';
import type { MaskId } from '@nos/core';
import { DiamondIcon, PlusIcon, WandSparklesIcon, XIcon } from 'lucide-react';
import { type EffectStackEntry, EditableName, EffectStack } from '@nos/ui';
import { Button } from '@nos/ui/components/ui/button';
import { Field, FieldTitle } from '@nos/ui/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@nos/ui/components/ui/native-select';
import { Input } from '@nos/ui/components/ui/input';
import { Label } from '@nos/ui/components/ui/label';
import { Slider } from '@nos/ui/components/ui/slider';
import { Switch } from '@nos/ui/components/ui/switch';
import { Toggle } from '@nos/ui/components/ui/toggle';
import { AudioMix } from './AudioMix.js';
import { TransformInspector } from './TransformInspector.js';

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
  /** Where the playhead is, so an animated value reads as what is heard or seen right now. */
  readonly playhead: number;
  readonly onChange: (label: string, next: TimelineDocument) => void;
  /** Surfaces a rejected edit, since a transition can legitimately be refused. */
  readonly onReject?: ((reason: string) => void) | undefined;
  /**
   * The masks an effect on this clip may be bound to.
   *
   * Supplied rather than derived, because what masks exist is a question about a segmentation session
   * that this panel does not own — and passing an empty list is the honest state for a clip nobody has
   * segmented, which is what makes the control say so instead of vanishing.
   */
  readonly masks?: readonly MaskChoice[] | undefined;
  /**
   * Renames the clip. Absent leaves the name read-only rather than showing a field that does nothing.
   */
  readonly onRename?: ((clip: ClipId, name: string) => void) | undefined;
  /**
   * Opens the name field without a double-click, for a rename asked for from the context menu.
   *
   * Driven from outside for the same reason the track rename is: two ways of renaming that behaved
   * differently would be worse than one.
   */
  readonly renaming?: boolean | undefined;
}

/** One bindable mask, as the inspector needs to show it. */
export interface MaskChoice {
  readonly id: MaskId;
  readonly label: string;
  /** False while a mask has been prompted but not yet propagated, so the row can say so. */
  readonly ready: boolean;
}

export function ClipInspector({
  document,
  clip,
  effects,
  playhead,
  onChange,
  onReject,
  masks,
  onRename,
  renaming,
}: ClipInspectorProps): ReactNode {
  const [selected, setSelected] = useState<EffectInstanceId | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  const located = clip === undefined ? undefined : locateClip(document, clip as never);
  if (located === undefined) {
    return (
      <div className="p-4">
        <p className="font-mono text-xs text-muted-foreground">no clip selected</p>
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
    <div className="flex min-w-0 flex-col gap-3 p-3">
      {/* The clip's name, and the only place it can be changed. Three kept variants of one generator
          all arrive called `Stable Audio 3`, and a bin of `ad0eb912-…` files gives nothing else to tell
          them apart by — naming them is how an edit stays legible to whoever opens it next. */}
      <EditableName
        value={located.clip.label}
        title={`${located.clip.label} — double-click to rename`}
        className="font-mono text-xs text-muted-foreground"
        autoEdit={renaming === true}
        {...(onRename !== undefined ? { onCommit: (name: string) => onRename(located.clip.id, name) } : {})}
      />

      {/* Framing first: where a clip is and how much of it shows are questions about the clip itself,
          where an effect stack is about what is done to it afterwards. */}
      <TransformInspector
        document={document}
        clip={located.clip}
        playhead={playhead}
        onChange={onChange}
        {...(onReject !== undefined ? { onReject } : {})}
      />

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

      <AudioMix document={document} clip={located.clip} playhead={playhead} onChange={onChange} />

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
          masks={masks ?? []}
          onParams={(params) =>
            apply(
              'set effect parameter',
              stack.map((entry) => (entry.id === selected ? { ...entry, params } : entry)),
            )
          }
          onMask={(mask) =>
            apply(
              'bind mask',
              stack.map((entry) => {
                if (entry.id !== selected) return entry;
                // Rebuilt rather than spread: `mask: undefined` would put a key holding undefined in
                // the document, and `project.json` reads that back as a value rather than an absence.
                const { mask: _previous, ...rest } = entry;
                return mask === undefined ? rest : { ...rest, mask };
              }),
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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Transitions</span>
        <Input
          type="number"
          aria-label="Transition frames"
          min={2}
          max={120}
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
          className="ml-auto h-7 w-15 font-mono tabular-nums"
        />
      </div>

      {existing.map((transition) => (
        <div key={transition.id} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-primary">{`${transition.effect} · ${transition.span.duration}f`}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label={`Remove the ${transition.effect} transition`}
              onClick={() => {
                const result = removeTransition(document, transition.id);
                if (result.ok) onChange('remove transition', result.value);
                else onReject?.(describeTransitionError(result.error));
              }}
              title="Remove this transition and return both clips to the cut"
            >
              <XIcon />
            </Button>
          </div>

          {/* The same panel the effect stack uses, from the same manifest. A transition's parameters
            were the last thing in the document that nothing could write: the built-in wipe declares a
            `softness`, the compositor read it, and every wipe in every project sat at the default. */}
          <EffectParams
            instance={transition}
            effects={effects}
            masks={[]}
            onParams={(params) => {
              const result = setTransitionParams(document, transition.id, params);
              if (result.ok) onChange('set transition parameter', result.value);
              else onReject?.(describeTransitionError(result.error));
            }}
          />
        </div>
      ))}

      {available.length === 0 && (
        <p className="font-mono text-xs text-muted-foreground">no transition effects are registered</p>
      )}

      {(['before', 'after'] as const).map((side) => {
        const pair = side === 'before' ? neighbours.before : neighbours.after;
        return (
          <div key={side} className="flex items-center gap-1">
            <span className="w-11 font-mono text-xs text-muted-foreground">{side}</span>
            {available.map((entry) => (
              <Button
                key={entry.id}
                variant="outline"
                size="xs"
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
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <WandSparklesIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Add effect</span>
      </div>
      {available.map((entry, index) => (
        <Button
          key={entry.id ?? `invalid-${index}`}
          variant="ghost"
          size="sm"
          disabled={entry.status !== 'available' || entry.id === undefined}
          onClick={() => entry.id !== undefined && onPick(entry.id)}
          title={entry.status === 'available' ? entry.manifest.name : describeEntryProblem(entry)}
          className="justify-start"
        >
          <PlusIcon />
          {entry.status === 'available' ? entry.manifest.name : (entry.id ?? 'a broken manifest')}
        </Button>
      ))}
      {available.length === 0 && (
        <p className="font-mono text-xs text-muted-foreground">no effects are registered</p>
      )}
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
/**
 * The part of an effect or a transition that a parameter panel needs.
 *
 * Written as its own interface so both can use one panel. They are different things in the document —
 * one sits in a clip's stack, the other spans a cut and carries the two clips it joins — but a
 * parameter is a parameter, and the controls for one are generated from the manifest either way.
 *
 * The alternative was a second copy of the sliders for transitions, which is how the two would come to
 * disagree about what animating a value means.
 */
interface ParameterizedEffect {
  readonly id: EffectInstanceId;
  readonly effect: EffectId;
  readonly params: Readonly<Record<string, AnimatableNumber | StaticValue>>;
  readonly mask?: MaskId;
}

function EffectParams({
  instance,
  effects,
  masks,
  onParams,
  onMask,
}: {
  readonly instance: ParameterizedEffect | undefined;
  readonly effects: EffectRegistry;
  readonly masks: readonly MaskChoice[];
  /** The parameters after an edit. Only the parameters — the caller owns everything else. */
  readonly onParams: (params: ParameterizedEffect['params']) => void;
  /** Absent hides the mask control, which is right for a transition: its samplers are `from` and `to`. */
  readonly onMask?: ((mask: MaskId | undefined) => void) | undefined;
}): ReactNode {
  if (instance === undefined) return null;

  const manifest = effects.manifestFor(instance.effect);
  const declared = manifest?.params ?? [];
  // Declaring the `mask` slot is the *entire* coupling between SAM 2 and the effect system, so it is
  // also the only thing that decides whether this control exists.
  const takesMask = manifest?.samplers.includes('mask') === true && onMask !== undefined;

  if (declared.length === 0 && !takesMask) {
    return <p className="font-mono text-xs text-muted-foreground">this effect declares no parameters</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {manifest?.name ?? instance.effect}
      </span>

      {takesMask && (
        <Labelled label="Mask">
          {masks.length === 0 ? (
            // Said rather than hidden, for the same reason an unavailable generator is greyed with its
            // reason: an effect that declares a mask slot and offers no way to fill it looks broken.
            <Input readOnly value="segment this clip to get a mask" />
          ) : (
            <NativeSelect
              aria-label="Mask"
              className="w-full"
              value={instance.mask ?? ''}
              onChange={(event) => {
                const chosen = event.target.value;
                onMask?.(chosen === '' ? undefined : (chosen as MaskId));
              }}
            >
              <NativeSelectOption value="">not bound</NativeSelectOption>
              {masks.map((choice) => (
                <NativeSelectOption key={choice.id} value={choice.id}>
                  {choice.ready ? choice.label : `${choice.label} — not segmented yet`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Labelled>
      )}

      {declared.map((param) => {
        const value = instance.params[param.key];
        const animated = value !== undefined && isAnimated(value as never);

        return (
          <Field key={param.key} className="gap-1">
            {/* Not a `<label>`: the control it would name is wrapped in its own below, and a second
                label pointing at a slider root that cannot be labelled named nothing while making the
                parameter look like it had two. */}
            <span className="text-xs font-medium">
              {param.key}
              {animated ? ' · animated' : ''}
            </span>

            {param.keyframable === true && (
              // Animating is an explicit act. A parameter silently becoming keyframed on first edit
              // would surprise anyone who only meant to change its value once.
              <Toggle
                size="sm"
                pressed={animated}
                aria-label={animated ? `Stop animating ${param.key}` : `Animate ${param.key}`}
                onPressedChange={() =>
                  onParams({
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
                  })
                }
                title={animated ? 'Return this to a constant value' : 'Animate this with keyframes'}
                className="self-start"
              >
                <DiamondIcon />
              </Toggle>
            )}

            {param.type === 'bool' ? (
              <Switch
                id={`param-${instance.id}-${param.key}`}
                disabled={animated}
                checked={readNumber(value, param.default) >= 0.5}
                onCheckedChange={(next) =>
                  onParams({ ...instance.params, [param.key]: constant(next ? 1 : 0) })
                }
                className="self-start"
              />
            ) : (
              /* Wrapped in a label rather than given an `aria-label`. The slider spreads its props
                 onto its root, and the control that needs a name is the range input inside its thumb —
                 so every parameter slider in this panel had no accessible name at all, and neither the
                 `id` and the `aria-label` that used to be here reached nothing. Implicit association
                 is what reaches the input, so the name lives in the label. */
              <Label className="w-full">
                <span className="sr-only">{param.key}</span>
                <Slider
                  disabled={animated}
                  min={param.min ?? 0}
                  max={param.max ?? 1}
                  step={(param.max ?? 1) - (param.min ?? 0) > 4 ? 1 : 0.01}
                  // The array form even for one value: given a scalar the registry falls back to
                  // `[min, max]` and renders a second thumb.
                  value={[readNumber(value, param.default)]}
                  onValueChange={(next) =>
                    onParams({
                      ...instance.params,
                      [param.key]: constant(Array.isArray(next) ? (next[0] ?? 0) : next),
                    })
                  }
                />
              </Label>
            )}
          </Field>
        );
      })}
    </div>
  );
}

/**
 * A caption above a control that already names itself.
 *
 * `FieldTitle` rather than `FieldLabel`: the control carries its own `aria-label`, and a second
 * association would give it two accessible names.
 */
function Labelled({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <Field className="gap-1">
      <FieldTitle className="text-xs">{label}</FieldTitle>
      {children}
    </Field>
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
