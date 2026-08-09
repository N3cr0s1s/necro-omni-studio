import { formatFrameRate } from '../time/frame-rate.js';
import { type FrameSpan } from '../time/frame-span.js';
import {
  type AnimatableNumber,
  type Keyframe,
  type RgbaColor,
  type StaticValue,
} from '../document/params.js';
import {
  type AudioClip,
  type Clip,
  type ClipFade,
  type ClipSpeed,
  type ClipTransform,
  type EffectInstance,
  type GeneratorProvenance,
  type ImageClip,
  type MediaSource,
  type TextAnimation,
  type TextClip,
  type TextContent,
  type Transition,
  type VideoClip,
} from '../document/clip.js';
import { type Track } from '../document/track.js';
import { type StoryBeat } from '../document/story.js';
import {
  type MaskDefinition,
  type Marker,
  type Sequence,
  type TimelineDocument,
} from '../document/document.js';

/**
 * Serializes a document to the `project.json` shape.
 *
 * ## Why this is hand-written rather than `JSON.stringify(document)`
 *
 * The in-memory model and the file format deliberately differ:
 *
 * - Frame rates become `"30000/1001"`, so the exact rational survives instead of being
 *   rounded through a float.
 * - A constant parameter becomes a bare number (`"opacity": 1`) rather than a tagged
 *   union, because the project folder is the user's to open, diff and hand-edit.
 * - Fields equal to their defaults are omitted, which keeps a real project readable and
 *   keeps diffs about what actually changed.
 *
 * Every omission here has a matching default in `document-schema.ts`; the round-trip test
 * is what holds the two halves honest.
 */

/** JSON-safe value. `unknown` would let a `Map` or a `Date` slip through unnoticed. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** Drops keys whose value is `undefined`, so omitted fields never appear as `null`. */
function compact(entries: Record<string, JsonValue | undefined>): JsonObject {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

/** Returns `undefined` when the value equals the default, so the key is omitted. */
function unlessDefault<T extends JsonValue>(value: T, fallback: T): T | undefined {
  return value === fallback ? undefined : value;
}

export function serializeFrameSpan(span: FrameSpan): JsonObject {
  return { start: span.start as number, duration: span.duration as number };
}

export function serializeColor(color: RgbaColor): JsonObject {
  return compact({
    r: color.r,
    g: color.g,
    b: color.b,
    a: unlessDefault(color.a, 1),
  });
}

export function serializeKeyframe(keyframe: Keyframe): JsonObject {
  return compact({
    id: keyframe.id as string,
    frame: keyframe.frame as number,
    value: keyframe.value,
    ease: unlessDefault<JsonValue>(keyframe.ease, 'linear'),
    // Written whenever it exists, not only while `ease` is `bezier`: a curve someone shaped is kept
    // through a trip to `hold` and back, and dropping it on save would make that trip destructive.
    bezier:
      keyframe.bezier === undefined
        ? undefined
        : {
            x1: keyframe.bezier.x1,
            y1: keyframe.bezier.y1,
            x2: keyframe.bezier.x2,
            y2: keyframe.bezier.y2,
          },
  });
}

/** A constant collapses to a bare number; only an animated parameter needs an object. */
export function serializeAnimatable(param: AnimatableNumber): JsonValue {
  if (param.kind === 'static') return param.value;
  return { keyframes: param.keyframes.map(serializeKeyframe) };
}

export function serializeParamValue(value: AnimatableNumber | StaticValue): JsonValue {
  switch (value.kind) {
    case 'static':
    case 'animated':
      return serializeAnimatable(value);
    case 'boolean':
    case 'string':
      return value.value;
    case 'number':
      return value.value;
    case 'color':
      return serializeColor(value.value);
    default: {
      const unreachable: never = value;
      throw new Error(`Unhandled parameter value ${JSON.stringify(unreachable)}`);
    }
  }
}

function serializeParams(
  params: Readonly<Record<string, AnimatableNumber | StaticValue>>,
): JsonObject | undefined {
  const keys = Object.keys(params);
  if (keys.length === 0) return undefined;
  const output: Record<string, JsonValue> = {};
  for (const key of keys) output[key] = serializeParamValue(params[key]!);
  return output;
}

export function serializeEffectInstance(effect: EffectInstance): JsonObject {
  return compact({
    id: effect.id as string,
    effect: effect.effect as string,
    enabled: unlessDefault(effect.enabled, true),
    params: serializeParams(effect.params),
    mask: effect.mask as string | undefined,
  });
}

export function serializeMediaSource(source: MediaSource): JsonObject {
  return {
    asset: source.asset as string,
    sourceIn: source.sourceIn as number,
    sourceRate: formatFrameRate(source.sourceRate),
  };
}

export function serializeProvenance(provenance: GeneratorProvenance): JsonObject {
  return compact({
    generator: provenance.generator as string,
    preset: provenance.preset as string | undefined,
    run: provenance.run as string,
    seed: provenance.seed,
    createdAt: unlessDefault(provenance.createdAt, ''),
  });
}

/** Omits transform channels left at their identity value. */
export function serializeTransform(transform: ClipTransform): JsonObject | undefined {
  const output = compact({
    x: isStaticValue(transform.x, 0) ? undefined : serializeAnimatable(transform.x),
    y: isStaticValue(transform.y, 0) ? undefined : serializeAnimatable(transform.y),
    scale: isStaticValue(transform.scale, 1) ? undefined : serializeAnimatable(transform.scale),
    rotation: isStaticValue(transform.rotation, 0) ? undefined : serializeAnimatable(transform.rotation),
    opacity: isStaticValue(transform.opacity, 1) ? undefined : serializeAnimatable(transform.opacity),
  });
  return Object.keys(output).length === 0 ? undefined : output;
}

function isStaticValue(param: AnimatableNumber, expected: number): boolean {
  return param.kind === 'static' && param.value === expected;
}

export function serializeSpeed(speed: ClipSpeed): JsonObject | undefined {
  if (speed.factor === 1 && speed.preservePitch) return undefined;
  return compact({
    factor: unlessDefault(speed.factor, 1),
    preservePitch: unlessDefault(speed.preservePitch, true),
  });
}

/**
 * Edge ramps, omitted when there are none.
 *
 * A fade of zero at both edges is what almost every clip has, and writing it would put an object in
 * every clip of every project for every reader to skip.
 */
export function serializeFade(fade: ClipFade | undefined): JsonObject | undefined {
  if (fade === undefined || (fade.inFrames === 0 && fade.outFrames === 0)) return undefined;
  return compact({
    inFrames: unlessDefault(fade.inFrames, 0),
    outFrames: unlessDefault(fade.outFrames, 0),
    shape: fade.shape,
    // Written whenever it exists, like a keyframe's, so trying another shape and coming back does not
    // throw away a curve somebody drew.
    shapeBezier:
      fade.shapeBezier === undefined
        ? undefined
        : {
            x1: fade.shapeBezier.x1,
            y1: fade.shapeBezier.y1,
            x2: fade.shapeBezier.x2,
            y2: fade.shapeBezier.y2,
          },
  });
}

function serializeClipBase(clip: Clip): Record<string, JsonValue | undefined> {
  return {
    id: clip.id as string,
    kind: clip.kind,
    span: serializeFrameSpan(clip.span),
    label: unlessDefault(clip.label, ''),
    enabled: unlessDefault(clip.enabled, true),
    effects: clip.effects.length === 0 ? undefined : clip.effects.map(serializeEffectInstance),
    provenance: clip.provenance === undefined ? undefined : serializeProvenance(clip.provenance),
    fade: serializeFade(clip.fade),
  };
}

export function serializeVideoClip(clip: VideoClip): JsonObject {
  return compact({
    ...serializeClipBase(clip),
    source: serializeMediaSource(clip.source),
    transform: serializeTransform(clip.transform),
    speed: serializeSpeed(clip.speed),
    linkedAudio: clip.linkedAudio as string | undefined,
  });
}

export function serializeImageClip(clip: ImageClip): JsonObject {
  return compact({
    ...serializeClipBase(clip),
    source: serializeMediaSource(clip.source),
    transform: serializeTransform(clip.transform),
  });
}

export function serializeAudioClip(clip: AudioClip): JsonObject {
  return compact({
    ...serializeClipBase(clip),
    source: serializeMediaSource(clip.source),
    speed: serializeSpeed(clip.speed),
    gain: isStaticValue(clip.gain, 1) ? undefined : serializeAnimatable(clip.gain),
    pan: isStaticValue(clip.pan, 0) ? undefined : serializeAnimatable(clip.pan),
    linkedVideo: clip.linkedVideo as string | undefined,
  });
}

export function serializeTextContent(content: TextContent): JsonObject {
  return compact({
    text: content.text,
    font: unlessDefault(content.font, 'system-ui'),
    size: unlessDefault(content.size, 48),
    weight: unlessDefault(content.weight, 600),
    color: isWhite(content.color) ? undefined : serializeColor(content.color),
    outline:
      content.outline === undefined
        ? undefined
        : { width: content.outline.width, color: serializeColor(content.outline.color) },
    shadow:
      content.shadow === undefined
        ? undefined
        : {
            offsetX: content.shadow.offsetX,
            offsetY: content.shadow.offsetY,
            blur: content.shadow.blur,
            color: serializeColor(content.shadow.color),
          },
    align: unlessDefault<JsonValue>(content.align, 'center'),
    lineHeight: unlessDefault(content.lineHeight, 1.2),
    letterSpacing: unlessDefault(content.letterSpacing, 0),
  });
}

function isWhite(color: RgbaColor): boolean {
  return color.r === 1 && color.g === 1 && color.b === 1 && color.a === 1;
}

export function serializeTextAnimation(animation: TextAnimation): JsonObject {
  return compact({
    preset: animation.preset,
    direction: animation.direction,
    durationFrames: unlessDefault(animation.durationFrames, 0),
    ease: unlessDefault(animation.ease, 'linear'),
  });
}

export function serializeTextClip(clip: TextClip): JsonObject {
  return compact({
    ...serializeClipBase(clip),
    content: serializeTextContent(clip.content),
    transform: serializeTransform(clip.transform),
    animateIn: clip.animateIn === undefined ? undefined : serializeTextAnimation(clip.animateIn),
    animateOut: clip.animateOut === undefined ? undefined : serializeTextAnimation(clip.animateOut),
    reveal: clip.reveal === undefined ? undefined : serializeAnimatable(clip.reveal),
  });
}

export function serializeClip(clip: Clip): JsonObject {
  switch (clip.kind) {
    case 'video':
      return serializeVideoClip(clip);
    case 'image':
      return serializeImageClip(clip);
    case 'audio':
      return serializeAudioClip(clip);
    case 'text':
      return serializeTextClip(clip);
    default: {
      const unreachable: never = clip;
      throw new Error(`Unhandled clip kind ${JSON.stringify(unreachable)}`);
    }
  }
}

export function serializeTransition(transition: Transition): JsonObject {
  return compact({
    id: transition.id as string,
    effect: transition.effect as string,
    span: serializeFrameSpan(transition.span),
    from: transition.from as string,
    to: transition.to as string,
    params: serializeParams(transition.params),
  });
}

export function serializeTrack(track: Track): JsonObject {
  const base: Record<string, JsonValue | undefined> = {
    id: track.id as string,
    kind: track.kind,
    name: unlessDefault(track.name, ''),
    muted: unlessDefault(track.muted, false),
    solo: unlessDefault(track.solo, false),
    locked: unlessDefault(track.locked, false),
    height: track.height,
    collapsed: unlessDefault(track.collapsed, false),
    clips: track.clips.length === 0 ? undefined : track.clips.map(serializeClip),
  };

  switch (track.kind) {
    case 'video':
      return compact({
        ...base,
        transitions: track.transitions.length === 0 ? undefined : track.transitions.map(serializeTransition),
      });
    case 'audio':
      return compact({
        ...base,
        gain: unlessDefault(track.gain, 1),
        pan: unlessDefault(track.pan, 0),
      });
    case 'text':
      return compact(base);
    default: {
      const unreachable: never = track;
      throw new Error(`Unhandled track kind ${JSON.stringify(unreachable)}`);
    }
  }
}

export function serializeMarker(marker: Marker): JsonObject {
  return compact({
    frame: marker.frame as number,
    label: unlessDefault(marker.label, ''),
    color: marker.color,
  });
}

export function serializeMask(mask: MaskDefinition): JsonObject {
  return compact({
    id: mask.id as string,
    clip: mask.clip as string,
    span: serializeFrameSpan(mask.span),
    asset: mask.asset as string,
    points:
      mask.points.length === 0
        ? undefined
        : mask.points.map((point) =>
            compact({
              frame: point.frame as number,
              x: point.x,
              y: point.y,
              include: unlessDefault(point.include, true),
            }),
          ),
  });
}

export function serializeSequence(sequence: Sequence): JsonObject {
  return compact({
    id: sequence.id as string,
    tracks: sequence.tracks.map(serializeTrack),
    workRange: sequence.workRange === undefined ? undefined : serializeFrameSpan(sequence.workRange),
    markers: sequence.markers.length === 0 ? undefined : sequence.markers.map(serializeMarker),
  });
}

export function serializeDocument(document: TimelineDocument): JsonObject {
  return compact({
    schemaVersion: document.schemaVersion,
    id: document.id as string,
    name: document.name,
    frameRate: formatFrameRate(document.frameRate),
    resolution: { width: document.resolution.width, height: document.resolution.height },
    sequence: serializeSequence(document.sequence),
    masks: document.masks.length === 0 ? undefined : document.masks.map(serializeMask),
    // Omitted entirely when there is no board, like every other empty collection here: a project that
    // never used the feature reads the same as it did before the feature existed.
    story: document.story.length === 0 ? undefined : document.story.map(serializeStoryBeat),
  });
}

/**
 * A story beat, per issue #33.
 *
 * `title` and `notes` are written even when empty, unlike most fields here. A beat *is* its text, and
 * omitting an empty one would make a freshly dropped beat and a beat someone deliberately blanked
 * indistinguishable on disk — the schema fills both back in as empty, so nothing breaks, but the file
 * stops describing what the user actually did.
 */
export function serializeStoryBeat(beat: StoryBeat): JsonObject {
  return compact({
    id: beat.id as string,
    span: serializeFrameSpan(beat.span),
    title: beat.title,
    notes: beat.notes,
    references:
      beat.references.length === 0
        ? undefined
        : beat.references.map((reference) =>
            compact({ asset: reference.asset as string, note: reference.note }),
          ),
    accent: beat.accent,
  });
}

/**
 * Renders `project.json` text.
 *
 * Two-space indentation and a trailing newline: the file lives in the user's project
 * folder and will end up in version control, where a stable, diffable format matters more
 * than a few saved bytes.
 */
export function stringifyDocument(document: TimelineDocument): string {
  return `${JSON.stringify(serializeDocument(document), null, 2)}\n`;
}
