import { type FrameRate } from '../time/frame-rate.js';
import { type FrameIndex } from '../time/frame-time.js';
import { type FrameSpan } from '../time/frame-span.js';
import {
  type AssetPath,
  type ClipId,
  type EffectId,
  type EffectInstanceId,
  type GeneratorId,
  type JobRunId,
  type MaskId,
  type PresetId,
} from './ids.js';
import { type AnimatableNumber, type RgbaColor, type StaticValue, isAnimated } from './params.js';

/**
 * Where a clip's pixels or samples come from.
 *
 * `sourceIn` is expressed in the *source's own* rate, not the project rate. Keeping the
 * source rate on the clip is what allows frame-exact reads from mixed-rate media: the
 * timeline works at the project rate, and the rebase happens once, at read time,
 * through the time layer's exact conversion.
 */
export interface MediaSource {
  readonly asset: AssetPath;
  readonly sourceIn: FrameIndex;
  readonly sourceRate: FrameRate;
}

/**
 * Record of the generator run that produced a clip.
 *
 * Purely informational to the engine, but load-bearing for the UI: the mockups colour
 * anything with provenance purple, and reproducing a result needs the generator, the
 * preset and the seed together. Kept on the clip rather than in a side table so that
 * zipping the project folder preserves it.
 */
export interface GeneratorProvenance {
  readonly generator: GeneratorId;
  readonly preset?: PresetId;
  readonly run: JobRunId;
  readonly seed?: number;
  /** ISO-8601, for display only. Never used for ordering or cache invalidation. */
  readonly createdAt: string;
}

/**
 * One entry in a clip's effect stack.
 *
 * `effect` names a manifest in the registry; `params` are keyed by the manifest's
 * parameter keys. Nothing here knows what the effect does — that is the whole point of
 * the manifest indirection, and it is why an unknown `effect` id must degrade to a
 * disabled stack entry rather than a load failure.
 */
export interface EffectInstance {
  readonly id: EffectInstanceId;
  readonly effect: EffectId;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, AnimatableNumber | StaticValue>>;
  /**
   * Mask bound to the effect's `mask` sampler slot, if it declares one. This is the only
   * coupling between segmentation and the effect system.
   */
  readonly mask?: MaskId;
}

/**
 * Geometric and level properties every visual clip has.
 *
 * Separate from the effect stack because these are intrinsic to placing a clip on a
 * track, not a pass in the shader chain. Position is normalized to `[0, 1]` of the
 * output so a transform survives a resolution change.
 */
export interface ClipTransform {
  readonly x: AnimatableNumber;
  readonly y: AnimatableNumber;
  readonly scale: AnimatableNumber;
  readonly rotation: AnimatableNumber;
  readonly opacity: AnimatableNumber;
}

/** Playback rate as a multiplier. Retimes the source read, not the timeline placement. */
export interface ClipSpeed {
  readonly factor: number;
  /**
   * Whether audio pitch is preserved when retiming. Ignored for video-only clips.
   */
  readonly preservePitch: boolean;
}

export interface ClipBase {
  readonly id: ClipId;
  /** Placement on the timeline, in project-rate frames. */
  readonly span: FrameSpan;
  readonly label: string;
  /** A disabled clip keeps its slot but contributes nothing to the composite. */
  readonly enabled: boolean;
  readonly effects: readonly EffectInstance[];
  readonly provenance?: GeneratorProvenance;
}

export interface VideoClip extends ClipBase {
  readonly kind: 'video';
  readonly source: MediaSource;
  readonly transform: ClipTransform;
  readonly speed: ClipSpeed;
  /**
   * Audio stream split out of the same file at import.
   *
   * The spec requires a video whose output carries audio to appear as a video clip with
   * a linked audio clip beneath it, so the link is explicit rather than inferred from
   * matching asset paths — two cuts of the same file must not appear linked.
   */
  readonly linkedAudio?: ClipId;
}

/** A still image placed on a video track. Duration is authored, not intrinsic. */
export interface ImageClip extends ClipBase {
  readonly kind: 'image';
  readonly source: MediaSource;
  readonly transform: ClipTransform;
}

export interface AudioClip extends ClipBase {
  readonly kind: 'audio';
  readonly source: MediaSource;
  readonly speed: ClipSpeed;
  /** Linear gain multiplier; the UI presents it in dB. */
  readonly gain: AnimatableNumber;
  /** −1 hard left to +1 hard right. */
  readonly pan: AnimatableNumber;
  readonly linkedVideo?: ClipId;
}

/**
 * Text properties.
 *
 * Split into cache-invalidating and transform-only groups, matching the spec's
 * rasterization rule: the texture cache key is the hash of the non-animatable fields, so
 * an animated text clip rasterizes once for its whole duration instead of per frame.
 */
export interface TextContent {
  readonly text: string;
  readonly font: string;
  readonly size: number;
  readonly weight: number;
  readonly color: RgbaColor;
  readonly outline?: TextOutline;
  readonly shadow?: TextShadow;
  readonly align: 'left' | 'center' | 'right';
  readonly lineHeight: number;
  readonly letterSpacing: number;
}

export interface TextOutline {
  readonly width: number;
  readonly color: RgbaColor;
}

export interface TextShadow {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly blur: number;
  readonly color: RgbaColor;
}

/**
 * Text in/out animation.
 *
 * A preset is a keyframe *generator*, not a runtime behaviour: applying one writes real
 * keyframes the user can then edit. The spec is explicit that there must be no hidden,
 * non-editable animation, so this record only remembers what was applied — it is never
 * consulted during rendering.
 */
export interface TextAnimation {
  readonly preset: TextAnimationPreset;
  readonly direction?: 'up' | 'down' | 'left' | 'right';
  /** In project-rate frames, matching the document-wide time base. */
  readonly durationFrames: number;
  readonly ease: string;
}

export type TextAnimationPreset = 'fade' | 'slide' | 'scale' | 'typewriter' | 'none';

export interface TextClip extends ClipBase {
  readonly kind: 'text';
  readonly content: TextContent;
  readonly transform: ClipTransform;
  readonly animateIn?: TextAnimation;
  readonly animateOut?: TextAnimation;
  /**
   * Fraction of characters revealed, `[0, 1]`.
   *
   * Typewriter cannot be a transform keyframe because the number of visible glyphs
   * changes, so it gets its own animatable channel that the renderer turns into a quad
   * clip against the cached advance list.
   */
  readonly reveal?: AnimatableNumber;
}

export type Clip = VideoClip | ImageClip | AudioClip | TextClip;

export type ClipKind = Clip['kind'];

/**
 * A transition occupying the overlap of two clips.
 *
 * Modelled as its own entity rather than as an effect on either clip, because it samples
 * both and its `progress` is computed by the engine from the overlap — the spec forbids
 * exposing that as a keyframable parameter.
 */
export interface Transition {
  readonly id: EffectInstanceId;
  readonly effect: EffectId;
  /** The overlap region, in project-rate frames. */
  readonly span: FrameSpan;
  readonly from: ClipId;
  readonly to: ClipId;
  readonly params: Readonly<Record<string, AnimatableNumber | StaticValue>>;
}

export function isVisualClip(clip: Clip): clip is VideoClip | ImageClip | TextClip {
  return clip.kind !== 'audio';
}

export function hasAudio(clip: Clip): clip is AudioClip {
  return clip.kind === 'audio';
}

export function isGenerated(clip: Clip): boolean {
  return clip.provenance !== undefined;
}

/** Media-backed clips expose a source; text clips do not. */
export function clipSource(clip: Clip): MediaSource | undefined {
  return clip.kind === 'text' ? undefined : clip.source;
}

/**
 * A clip's retime factor, or 1 for kinds that cannot be retimed.
 *
 * Stills and titles have no source rate to stretch, so they answer 1 rather than `undefined`:
 * callers converting timeline time to source time want a number they can multiply by, and every
 * one of them having to write `?? 1` is how a missing factor eventually gets forgotten.
 */
export function clipSpeed(clip: Clip): number {
  return clip.kind === 'video' || clip.kind === 'audio' ? clip.speed.factor : 1;
}

/** Every clip kind except text carries a transform; audio has none. */
export function clipTransform(clip: Clip): ClipTransform | undefined {
  return clip.kind === 'audio' ? undefined : clip.transform;
}

/**
 * Whether a clip has anything animated on it.
 *
 * Every place a keyframe can live, in one predicate: the transform, a text clip's reveal channel, an
 * audio clip's level and pan, and any effect parameter. The spec's §6.1 makes a clip *openable* to
 * show its parameter lanes, and the honest condition for offering that is "there is something to
 * show" — an empty disclosure is a control that punishes the user for using it.
 */
export function hasAnimation(clip: Clip): boolean {
  const transform = clipTransform(clip);
  if (transform !== undefined && Object.values(transform).some(isAnimated)) return true;
  if (clip.kind === 'text' && clip.reveal !== undefined && isAnimated(clip.reveal)) return true;
  if (clip.kind === 'audio' && (isAnimated(clip.gain) || isAnimated(clip.pan))) return true;

  // A parameter may hold a static value of a non-numeric kind — a colour, say — which cannot be
  // animated at all. Narrowing on the discriminant rather than casting keeps that honest.
  return clip.effects.some((instance) =>
    Object.values(instance.params).some((value) => value.kind === 'animated'),
  );
}

/** Count of render passes a clip contributes, for the spec's 8-pass warning. */
export function passCount(clip: Clip): number {
  return clip.effects.filter((effect) => effect.enabled).length;
}
