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

/**
 * Ramps at a clip's own edges, in project frames.
 *
 * Its own field rather than keyframes on gain and opacity, for three reasons the crossfade report
 * made concrete. A fade authored as keyframes is destroyed by the next automation the user writes,
 * and there is no way to ask "does this clip fade in" afterwards — the shape has to be recognized
 * from the curve. It has to be *removable*: a crossfade made by dropping one clip onto another is
 * undone by dragging it back off, and undoing an edit by pattern-matching keyframes is not something
 * to build. And a length is a number a person can type, which is what §6.1's frame accuracy asks for
 * everywhere else.
 *
 * On `ClipBase` rather than on `AudioClip`, because a ramp at an edge means the same thing in both
 * domains and only the quantity differs — level for sound, opacity for picture. A crossfade between
 * two stacked video clips is then the same edit as one between two sounds, which is exactly how a
 * user describes it.
 *
 * The two counts may overlap on a short clip; how they combine is the renderer's business, not the
 * document's.
 */
export interface ClipFade {
  /** Frames from the clip's in-point over which it ramps up from nothing. */
  readonly inFrames: number;
  /** Frames before the clip's out-point over which it ramps down to nothing. */
  readonly outFrames: number;
}

/** No ramp at either edge — what a clip has unless something asked otherwise. */
export const NO_FADE: ClipFade = { inFrames: 0, outFrames: 0 };

export interface ClipBase {
  readonly id: ClipId;
  /** Placement on the timeline, in project-rate frames. */
  readonly span: FrameSpan;
  readonly label: string;
  /** A disabled clip keeps its slot but contributes nothing to the composite. */
  readonly enabled: boolean;
  readonly effects: readonly EffectInstance[];
  readonly provenance?: GeneratorProvenance;
  /** Absent means no ramp at either edge, which is the common case and is not worth storing. */
  readonly fade?: ClipFade;
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

/**
 * The quad cut a `reveal` fraction turns into, in texture coordinates.
 *
 * Here rather than in the text package or the compositor because it is the seam *between* them: the
 * side that owns the fonts computes it, the side that owns the GL applies it, and neither should have
 * to depend on the other to name the thing they pass. Everything in it is a plain texture coordinate,
 * with no notion of a glyph left in it.
 *
 * Three regions rather than a per-line list, which falls out of the reveal running in reading order:
 * at any instant some lines are fully typed, **exactly one** is mid-word, and the rest have not
 * started. That describes any line count in three numbers, where a list would need a bound.
 *
 * `v` runs bottom-up, as the texture is uploaded, so *earlier* lines have the *greater* `v`.
 */
export interface TypewriterCut {
  /** Fragments above this — `v` greater — are fully typed and drawn whole. */
  readonly doneV: number;
  /** The mid-word line's band, `[bottom, top]`. Below `bottom` nothing is drawn yet. */
  readonly lineV: readonly [number, number];
  /** Within that band, draw only up to this `u`. */
  readonly lineU: number;
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
 * A clip's edge ramps, as numbers rather than as an absence.
 *
 * Every renderer multiplying a fade into something wants two counts it can arithmetic with, and each
 * of them writing `?? NO_FADE` is how one of them eventually forgets. Negatives are clamped here
 * rather than refused: a stored file is not a trusted input, and a fade of −5 frames should render as
 * no fade rather than as an inverted ramp nothing else in the system can express.
 */
export function clipFade(clip: Clip): ClipFade {
  const fade = clip.fade;
  if (fade === undefined) return NO_FADE;
  return { inFrames: Math.max(0, fade.inFrames), outFrames: Math.max(0, fade.outFrames) };
}

/** Whether a clip ramps at either edge. */
export function hasFade(clip: Clip): boolean {
  const fade = clipFade(clip);
  return fade.inFrames > 0 || fade.outFrames > 0;
}

/**
 * How far through its ramps a clip is at one of its own frames: 0 at silence, 1 at full.
 *
 * **Linear, and deliberately not the final multiplier.** Sound and picture want different curves —
 * two uncorrelated sounds crossfaded on a linear pair dip audibly in the middle, and a picture
 * crossfaded on an equal-power pair goes *bright* in the middle — so the shape belongs with each
 * renderer and only the position belongs here. What must be shared is where in the ramp a frame
 * falls, because a fade the mixer and the compositor disagreed about would be a crossfade that
 * sounds early.
 *
 * The **minimum** of the two ramps where they overlap on a short clip, so a clip shorter than its own
 * fades still reaches silence at both ends rather than jumping.
 *
 * Frame-relative to the clip, like keyframes, so a head trim moves the ramp with the picture.
 */
export function fadeAmountAt(clip: Clip, clipRelativeFrame: number): number {
  const fade = clipFade(clip);
  if (fade.inFrames === 0 && fade.outFrames === 0) return 1;

  const duration = clip.span.duration;
  const rising = fade.inFrames === 0 ? 1 : clipRelativeFrame / fade.inFrames;
  const falling = fade.outFrames === 0 ? 1 : (duration - clipRelativeFrame) / fade.outFrames;

  return Math.min(1, Math.max(0, Math.min(rising, falling)));
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

/**
 * The clip this one is linked to, if any.
 *
 * A video clip and the audio split out of the same file at import are one thing to a user, so an
 * operation on either reaches both. The link is *stored* on each side rather than inferred from
 * matching asset paths, because two cuts of the same file must not appear linked.
 */
export function linkedPartner(clip: Clip): ClipId | undefined {
  if (clip.kind === 'video') return clip.linkedAudio;
  if (clip.kind === 'audio') return clip.linkedVideo;
  return undefined;
}

/** Count of render passes a clip contributes, for the spec's 8-pass warning. */
export function passCount(clip: Clip): number {
  return clip.effects.filter((effect) => effect.enabled).length;
}
