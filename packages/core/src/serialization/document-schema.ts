import {
  type Validator,
  vArray,
  vBoolean,
  vEnum,
  vFallback,
  vInteger,
  vLiteral,
  vMap,
  vNonEmptyString,
  vNonNegativeInteger,
  vNumber,
  vObject,
  vOptional,
  vPositiveInteger,
  vRecord,
  vRefine,
  vString,
  vTagged,
  vTryMap,
  vWithDefault,
} from '../lang/validate.js';
import { type FrameRate, parseFrameRate } from '../time/frame-rate.js';
import { type FrameCount, type FrameIndex, frameCount, frameIndex } from '../time/frame-time.js';
import { type FrameSpan } from '../time/frame-span.js';
import {
  type AnimatableNumber,
  type Keyframe,
  type RgbaColor,
  type StaticValue,
  EASINGS,
  animatedNumber,
  staticNumber,
} from '../document/params.js';
import {
  type AssetPath,
  type ClipId,
  type EffectId,
  type EffectInstanceId,
  type GeneratorId,
  type JobRunId,
  type KeyframeId,
  type MaskId,
  type PresetId,
  type ProjectId,
  type SequenceId,
  type StoryBeatId,
  type TrackId,
  assetPath,
  clipId,
  effectId,
  effectInstanceId,
  generatorId,
  jobRunId,
  keyframeId,
  maskId,
  presetId,
  projectId,
  sequenceId,
  storyBeatId,
  trackId,
} from '../document/ids.js';
import {
  type AudioClip,
  type ClipSpeed,
  type ClipTransform,
  type EffectInstance,
  type GeneratorProvenance,
  type ImageClip,
  type MediaSource,
  type TextAnimation,
  type TextClip,
  type TextContent,
  type TextOutline,
  type TextShadow,
  type Transition,
  type VideoClip,
} from '../document/clip.js';
import { type AudioTrack, type TextTrack, type Track, type VideoTrack } from '../document/track.js';
import { STORY_ACCENTS, type StoryAccent, type StoryBeat, type StoryReference } from '../document/story.js';
import {
  type MaskDefinition,
  type MaskPoint,
  type Marker,
  type Resolution,
  type Sequence,
  type TimelineDocument,
} from '../document/document.js';

/**
 * `project.json` validators.
 *
 * Deliberately hand-written per entity rather than generated, because the on-disk shape
 * and the in-memory shape are allowed to diverge: the file trades a little redundancy for
 * readability (frame rates as `"30000/1001"`, a constant parameter as a bare number)
 * while memory trades readability for a shape the render loop can consume without
 * branching. This module is the only place that knows both.
 *
 * Every validator is exported so the migration chain can reuse pieces, and so a future
 * partial-import feature ("open just this sequence") does not have to re-derive them.
 */

/** `"30000/1001"` or `"25"`. Stored as text so the exact rational survives a round-trip. */
export const vFrameRate: Validator<FrameRate> = vTryMap(vString, parseFrameRate);

export const vFrameIndex: Validator<FrameIndex> = vTryMap(vInteger, frameIndex);
export const vFrameCount: Validator<FrameCount> = vTryMap(vInteger, frameCount);

export const vAssetPath: Validator<AssetPath> = vTryMap(vString, assetPath);

/** Ids are non-empty strings on disk; the brand is applied on the way in. */
function vId<T>(factory: (value: string) => T, label: string): Validator<T> {
  return vTryMap(vNonEmptyString(label), factory);
}

export const vProjectId: Validator<ProjectId> = vId(projectId, 'project id');
export const vSequenceId: Validator<SequenceId> = vId(sequenceId, 'sequence id');
export const vTrackId: Validator<TrackId> = vId(trackId, 'track id');
export const vClipId: Validator<ClipId> = vId(clipId, 'clip id');
export const vEffectInstanceId: Validator<EffectInstanceId> = vId(effectInstanceId, 'effect instance id');
export const vKeyframeId: Validator<KeyframeId> = vId(keyframeId, 'keyframe id');
export const vMaskId: Validator<MaskId> = vId(maskId, 'mask id');
export const vStoryBeatId: Validator<StoryBeatId> = vId(storyBeatId, 'story beat id');
export const vEffectId: Validator<EffectId> = vId(effectId, 'effect id');
export const vGeneratorId: Validator<GeneratorId> = vId(generatorId, 'generator id');
export const vPresetId: Validator<PresetId> = vId(presetId, 'preset id');
export const vJobRunId: Validator<JobRunId> = vId(jobRunId, 'job run id');

export const vFrameSpan: Validator<FrameSpan> = vObject<FrameSpan>({
  start: vFrameIndex,
  duration: vFrameCount,
});

export const vResolution: Validator<Resolution> = vObject<Resolution>({
  width: vPositiveInteger('width'),
  height: vPositiveInteger('height'),
});

export const vRgbaColor: Validator<RgbaColor> = vObject<RgbaColor>({
  r: vNumber,
  g: vNumber,
  b: vNumber,
  a: vWithDefault(vNumber, 1),
});

export const vKeyframe: Validator<Keyframe> = vObject<Keyframe>({
  id: vKeyframeId,
  frame: vFrameIndex,
  value: vNumber,
  // An unrecognized easing degrades to linear rather than failing the load: a project
  // written by a build with Bezier support must still open here, showing the segment
  // straight instead of refusing to show the timeline at all.
  ease: vFallback(vEnum(EASINGS), 'linear'),
});

/**
 * A parameter that may be animated.
 *
 * A bare number on disk means a constant — `"opacity": 1` rather than
 * `"opacity": {"kind": "static", "value": 1}`. That keeps a hand-inspected `project.json`
 * readable, which matters because the project folder is the user's to open and diff.
 */
export const vAnimatableNumber: Validator<AnimatableNumber> = (value, path) => {
  if (typeof value === 'number') return vMap(vNumber, staticNumber)(value, path);
  return vMap(vObject<{ keyframes: readonly Keyframe[] }>({ keyframes: vArray(vKeyframe) }), (parsed) =>
    animatedNumber(parsed.keyframes),
  )(value, path);
};

/**
 * Any effect parameter value.
 *
 * Dispatch is by JSON type, which is unambiguous here: numbers and keyframe objects are
 * animatable, booleans and strings are static, and an `{r,g,b}` object is a colour. No
 * discriminant field is needed, so the file stays terse.
 */
export const vParamValue: Validator<AnimatableNumber | StaticValue> = (value, path) => {
  if (typeof value === 'boolean') {
    return vMap(vBoolean, (parsed): StaticValue => ({ kind: 'boolean', value: parsed }))(value, path);
  }
  if (typeof value === 'string') {
    return vMap(vString, (parsed): StaticValue => ({ kind: 'string', value: parsed }))(value, path);
  }
  if (typeof value === 'object' && value !== null && 'r' in value) {
    return vMap(vRgbaColor, (parsed): StaticValue => ({ kind: 'color', value: parsed }))(value, path);
  }
  return vAnimatableNumber(value, path);
};

export const vParams: Validator<Readonly<Record<string, AnimatableNumber | StaticValue>>> = vWithDefault(
  vRecord(vParamValue),
  {},
);

export const vEffectInstance: Validator<EffectInstance> = vObject<EffectInstance>({
  id: vEffectInstanceId,
  effect: vEffectId,
  enabled: vWithDefault(vBoolean, true),
  params: vParams,
  mask: vOptional(vMaskId),
});

export const vMediaSource: Validator<MediaSource> = vObject<MediaSource>({
  asset: vAssetPath,
  sourceIn: vFrameIndex,
  sourceRate: vFrameRate,
});

export const vGeneratorProvenance: Validator<GeneratorProvenance> = vObject<GeneratorProvenance>({
  generator: vGeneratorId,
  preset: vOptional(vPresetId),
  run: vJobRunId,
  seed: vOptional(vInteger),
  createdAt: vWithDefault(vString, ''),
});

export const vClipTransform: Validator<ClipTransform> = vObject<ClipTransform>({
  x: vWithDefault(vAnimatableNumber, staticNumber(0)),
  y: vWithDefault(vAnimatableNumber, staticNumber(0)),
  scale: vWithDefault(vAnimatableNumber, staticNumber(1)),
  rotation: vWithDefault(vAnimatableNumber, staticNumber(0)),
  opacity: vWithDefault(vAnimatableNumber, staticNumber(1)),
});

export const DEFAULT_TRANSFORM: ClipTransform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

/**
 * Zero or negative speed has no meaning for a source read and would divide by zero in the
 * retimer, so it is rejected at the boundary instead of guarded at every read site.
 */
const vSpeedFactor: Validator<number> = vRefine(
  vNumber,
  (value) => value > 0,
  'speed factor must be positive',
);

export const vClipSpeed: Validator<ClipSpeed> = vObject<ClipSpeed>({
  factor: vWithDefault(vSpeedFactor, 1),
  preservePitch: vWithDefault(vBoolean, true),
});

export const DEFAULT_SPEED: ClipSpeed = { factor: 1, preservePitch: true };

const vClipBaseShape = {
  id: vClipId,
  span: vFrameSpan,
  label: vWithDefault(vString, ''),
  enabled: vWithDefault(vBoolean, true),
  effects: vWithDefault(vArray(vEffectInstance), []),
  provenance: vOptional(vGeneratorProvenance),
} as const;

export const vVideoClip: Validator<VideoClip> = vObject<VideoClip>({
  ...vClipBaseShape,
  kind: vLiteral('video'),
  source: vMediaSource,
  transform: vWithDefault(vClipTransform, DEFAULT_TRANSFORM),
  speed: vWithDefault(vClipSpeed, DEFAULT_SPEED),
  linkedAudio: vOptional(vClipId),
});

export const vImageClip: Validator<ImageClip> = vObject<ImageClip>({
  ...vClipBaseShape,
  kind: vLiteral('image'),
  source: vMediaSource,
  transform: vWithDefault(vClipTransform, DEFAULT_TRANSFORM),
});

export const vAudioClip: Validator<AudioClip> = vObject<AudioClip>({
  ...vClipBaseShape,
  kind: vLiteral('audio'),
  source: vMediaSource,
  speed: vWithDefault(vClipSpeed, DEFAULT_SPEED),
  gain: vWithDefault(vAnimatableNumber, staticNumber(1)),
  pan: vWithDefault(vAnimatableNumber, staticNumber(0)),
  linkedVideo: vOptional(vClipId),
});

export const vTextOutline: Validator<TextOutline> = vObject<TextOutline>({
  width: vNumber,
  color: vRgbaColor,
});

export const vTextShadow: Validator<TextShadow> = vObject<TextShadow>({
  offsetX: vNumber,
  offsetY: vNumber,
  blur: vNumber,
  color: vRgbaColor,
});

export const vTextContent: Validator<TextContent> = vObject<TextContent>({
  text: vWithDefault(vString, ''),
  font: vWithDefault(vString, 'system-ui'),
  size: vWithDefault(vNumber, 48),
  weight: vWithDefault(vInteger, 600),
  color: vWithDefault(vRgbaColor, { r: 1, g: 1, b: 1, a: 1 }),
  outline: vOptional(vTextOutline),
  shadow: vOptional(vTextShadow),
  align: vWithDefault(vEnum(['left', 'center', 'right'] as const), 'center'),
  lineHeight: vWithDefault(vNumber, 1.2),
  letterSpacing: vWithDefault(vNumber, 0),
});

export const vTextAnimation: Validator<TextAnimation> = vObject<TextAnimation>({
  preset: vEnum(['fade', 'slide', 'scale', 'typewriter', 'none'] as const),
  direction: vOptional(vEnum(['up', 'down', 'left', 'right'] as const)),
  durationFrames: vWithDefault(vNonNegativeInteger('duration'), 0),
  ease: vWithDefault(vString, 'linear'),
});

export const vTextClip: Validator<TextClip> = vObject<TextClip>({
  ...vClipBaseShape,
  kind: vLiteral('text'),
  content: vTextContent,
  transform: vWithDefault(vClipTransform, DEFAULT_TRANSFORM),
  animateIn: vOptional(vTextAnimation),
  animateOut: vOptional(vTextAnimation),
  reveal: vOptional(vAnimatableNumber),
});

export const vTransition: Validator<Transition> = vObject<Transition>({
  id: vEffectInstanceId,
  effect: vEffectId,
  span: vFrameSpan,
  from: vClipId,
  to: vClipId,
  params: vParams,
});

const vTrackBaseShape = {
  id: vTrackId,
  name: vWithDefault(vString, ''),
  muted: vWithDefault(vBoolean, false),
  solo: vWithDefault(vBoolean, false),
  locked: vWithDefault(vBoolean, false),
  height: vWithDefault(vPositiveInteger('height'), 64),
  collapsed: vWithDefault(vBoolean, false),
} as const;

/**
 * Video tracks accept both moving and still clips, so the element validator dispatches on
 * `kind` within the track rather than the track declaring a single clip type.
 */
export const vVideoTrack: Validator<VideoTrack> = vObject<VideoTrack>({
  ...vTrackBaseShape,
  kind: vLiteral('video'),
  clips: vWithDefault(
    vArray(
      vTagged<VideoClip | ImageClip>('kind', {
        video: vVideoClip,
        image: vImageClip,
      }),
    ),
    [],
  ),
  transitions: vWithDefault(vArray(vTransition), []),
});

export const vAudioTrack: Validator<AudioTrack> = vObject<AudioTrack>({
  ...vTrackBaseShape,
  kind: vLiteral('audio'),
  clips: vWithDefault(vArray(vAudioClip), []),
  gain: vWithDefault(vNumber, 1),
  pan: vWithDefault(vNumber, 0),
});

export const vTextTrack: Validator<TextTrack> = vObject<TextTrack>({
  ...vTrackBaseShape,
  kind: vLiteral('text'),
  clips: vWithDefault(vArray(vTextClip), []),
});

export const vTrack: Validator<Track> = vTagged<Track>('kind', {
  video: vVideoTrack,
  audio: vAudioTrack,
  text: vTextTrack,
});

export const vMarker: Validator<Marker> = vObject<Marker>({
  frame: vFrameIndex,
  label: vWithDefault(vString, ''),
  color: vOptional(vString),
});

export const vMaskPoint: Validator<MaskPoint> = vObject<MaskPoint>({
  frame: vFrameIndex,
  x: vNumber,
  y: vNumber,
  include: vWithDefault(vBoolean, true),
});

export const vMaskDefinition: Validator<MaskDefinition> = vObject<MaskDefinition>({
  id: vMaskId,
  clip: vClipId,
  span: vFrameSpan,
  asset: vAssetPath,
  points: vWithDefault(vArray(vMaskPoint), []),
});

/**
 * One of the five categorical roles, as a number.
 *
 * Written out rather than `vEnum`, which is for strings. Refusing an accent outside the range matters:
 * it is an index into the palette, and a sixth would render as no colour at all — a beat that draws
 * as nothing, in a file that loaded without complaint.
 */
const vStoryAccent: Validator<StoryAccent> = vRefine(
  vNumber as Validator<StoryAccent>,
  (value) => (STORY_ACCENTS as readonly number[]).includes(value),
  `expected one of ${STORY_ACCENTS.join(', ')}`,
);

/**
 * A beat's reference. The note is optional because the file is usually enough on its own.
 */
export const vStoryReference: Validator<StoryReference> = vObject<StoryReference>({
  asset: vAssetPath,
  note: vOptional(vString),
});

/**
 * A story beat, per issue #33.
 *
 * `title` and `notes` default to empty rather than being required: a beat is dropped on the timeline
 * first and written afterwards, and a schema that refused an unwritten one would make the board
 * unusable in exactly the moment it is most useful.
 *
 * `accent` is an index into the categorical roles, validated as one of five — a stored colour would be
 * the one place in this application naming a colour outside the palette, and unreadable in a theme it
 * was not chosen for.
 */
export const vStoryBeat: Validator<StoryBeat> = vObject<StoryBeat>({
  id: vStoryBeatId,
  span: vFrameSpan,
  title: vWithDefault(vString, ''),
  notes: vWithDefault(vString, ''),
  references: vWithDefault(vArray(vStoryReference), []),
  accent: vOptional(vStoryAccent),
});

export const vSequence: Validator<Sequence> = vObject<Sequence>({
  id: vSequenceId,
  tracks: vWithDefault(vArray(vTrack), []),
  workRange: vOptional(vFrameSpan),
  markers: vWithDefault(vArray(vMarker), []),
});

export const vTimelineDocument: Validator<TimelineDocument> = vObject<TimelineDocument>({
  schemaVersion: vNonNegativeInteger('schemaVersion'),
  id: vProjectId,
  name: vWithDefault(vString, 'Untitled'),
  frameRate: vFrameRate,
  resolution: vResolution,
  sequence: vSequence,
  masks: vWithDefault(vArray(vMaskDefinition), []),
  // Defaulted, so every project written before the board existed opens with an empty one rather than
  // failing to load.
  story: vWithDefault(vArray(vStoryBeat), []),
});
