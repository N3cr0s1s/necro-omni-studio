import { FRAME_RATES, frameRate } from '../time/frame-rate.js';
import { frameIndex } from '../time/frame-time.js';
import { spanFromBounds } from '../time/frame-span.js';
import { type TimelineDocument, createDocument } from '../document/document.js';
import { type AudioTrack, type TextTrack, type VideoTrack } from '../document/track.js';
import {
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
import { animatedNumber, staticNumber } from '../document/params.js';

/**
 * A project that uses every field the document model has.
 *
 * Lives in `src` rather than beside one test because two checks need the same document and they check
 * different things: `project-file.test.ts` saves it and compares what comes back, and
 * `every-field.test.ts` reads the model's own source and asserts that nothing it declares is missing
 * from the saved text. Neither check is worth much without the other — the first is blind to a field
 * the fixture never sets, and the second cannot tell whether what was written comes back intact.
 *
 * **Every optional field is set, and every flag is set away from its default somewhere.** That second
 * part is the one that is easy to lose: the serializer omits a value equal to its default, so a flag
 * written only at its default never reaches the file at all and proves nothing about the serializer.
 */
export function emptyDocument(): TimelineDocument {
  return createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'breakdown_v3',
    frameRate: FRAME_RATES.NTSC_29_97,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });
}

/**
 * A document exercising every branch of the serializer: all four clip kinds, animated and
 * constant parameters, an effect with a mask, a transition, markers and a work range.
 */
export function richDocument(): TimelineDocument {
  const base = emptyDocument();
  const videoTrack: VideoTrack = {
    kind: 'video',
    id: trackId('v1'),
    name: 'V1',
    muted: false,
    solo: false,
    locked: false,
    height: 84,
    collapsed: false,
    clips: [
      {
        kind: 'video',
        id: clipId('c1'),
        span: spanFromBounds(frameIndex(0), frameIndex(196)),
        label: 'interview_a · 01',
        enabled: true,
        source: {
          asset: assetPath('media/interview_a.mp4'),
          sourceIn: frameIndex(311),
          sourceRate: FRAME_RATES.NTSC_29_97,
        },
        transform: {
          x: staticNumber(0),
          y: staticNumber(-24),
          scale: staticNumber(1.08),
          rotation: staticNumber(0),
          opacity: animatedNumber([
            // A hand-drawn curve, so the control points are exercised rather than merely declared.
            // All four coordinates differ, or a fixture would round-trip identically with two of them
            // swapped.
            {
              id: keyframeId('kf1'),
              frame: frameIndex(0),
              value: 0,
              ease: 'bezier',
              bezier: { x1: 0.2, y1: 0.05, x2: 0.8, y2: 1.4 },
            },
            { id: keyframeId('kf2'), frame: frameIndex(30), value: 1, ease: 'linear' },
          ]),
        },
        speed: { factor: 1, preservePitch: true },
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: {
              amount: animatedNumber([
                { id: keyframeId('kf3'), frame: frameIndex(0), value: 0.15, ease: 'linear' },
              ]),
              size: staticNumber(1),
              invert: { kind: 'boolean', value: false },
              blendMode: { kind: 'string', value: 'overlay' },
              tint: { kind: 'color', value: { r: 1, g: 0.5, b: 0.25, a: 0.8 } },
            },
            mask: maskId('m1'),
          },
        ],
        linkedAudio: clipId('c3'),
      },
      {
        kind: 'video',
        id: clipId('c2'),
        span: spanFromBounds(frameIndex(398), frameIndex(530)),
        label: 't2v_0117',
        enabled: true,
        source: {
          asset: assetPath('generated/t2v_0117_seed4471.mp4'),
          sourceIn: frameIndex(0),
          // A generated clip at a different rate than the project exercises the rebase.
          sourceRate: frameRate(24),
        },
        transform: {
          x: staticNumber(0),
          y: staticNumber(0),
          scale: staticNumber(1),
          rotation: staticNumber(0),
          opacity: staticNumber(1),
        },
        speed: { factor: 0.5, preservePitch: false },
        effects: [],
        provenance: {
          generator: generatorId('minimax_h3_t2v'),
          preset: presetId('default'),
          run: jobRunId('run_0117'),
          seed: 4471,
          createdAt: '2026-08-08T00:12:00.000Z',
        },
      },
      {
        kind: 'image',
        id: clipId('c5'),
        span: spanFromBounds(frameIndex(600), frameIndex(660)),
        label: 'still',
        enabled: false,
        source: {
          asset: assetPath('media/frame.png'),
          sourceIn: frameIndex(0),
          sourceRate: FRAME_RATES.NTSC_29_97,
        },
        transform: {
          x: staticNumber(0.5),
          y: staticNumber(0),
          scale: staticNumber(1),
          rotation: staticNumber(90),
          opacity: staticNumber(1),
        },
        effects: [],
      },
    ],
    transitions: [
      {
        id: effectInstanceId('tr1'),
        effect: effectId('crosswarp'),
        span: spanFromBounds(frameIndex(190), frameIndex(196)),
        from: clipId('c1'),
        to: clipId('c2'),
        params: { strength: staticNumber(0.4) },
      },
    ],
  };

  const audioTrack: AudioTrack = {
    kind: 'audio',
    id: trackId('a1'),
    name: 'A1 · voice',
    muted: false,
    solo: true,
    locked: false,
    height: 60,
    collapsed: false,
    gain: 0.8,
    pan: -0.2,
    clips: [
      {
        kind: 'audio',
        id: clipId('c3'),
        span: spanFromBounds(frameIndex(0), frameIndex(530)),
        label: 'interview_a · voice',
        enabled: true,
        source: {
          asset: assetPath('media/interview_a.mp4'),
          sourceIn: frameIndex(311),
          sourceRate: FRAME_RATES.NTSC_29_97,
        },
        speed: { factor: 1, preservePitch: true },
        gain: animatedNumber([
          { id: keyframeId('kf4'), frame: frameIndex(0), value: 1, ease: 'hold' },
          { id: keyframeId('kf5'), frame: frameIndex(100), value: 0, ease: 'linear' },
        ]),
        pan: staticNumber(0),
        effects: [],
        // Both ramps set, and to different lengths: a fixture where they matched would round-trip
        // identically with the two fields swapped.
        // A hand-drawn fade curve, so the shape *and* its control points are exercised rather than
        // merely declared — the same reason the keyframe above carries one.
        fade: {
          inFrames: 12,
          outFrames: 30,
          shape: 'bezier',
          shapeBezier: { x1: 0.1, y1: 0.3, x2: 0.7, y2: 0.9 },
        },
        linkedVideo: clipId('c1'),
      },
    ],
  };

  const textTrack: TextTrack = {
    kind: 'text',
    id: trackId('t1'),
    name: 'T1 · text',
    // True somewhere, because the serializer omits a default and a field written only at its default
    // round-trips whether or not the serializer knows about it at all. `every-field.test.ts` is what
    // noticed this one was the last flag never set.
    muted: true,
    solo: false,
    locked: true,
    height: 46,
    collapsed: true,
    clips: [
      {
        kind: 'text',
        id: clipId('c4'),
        span: spanFromBounds(frameIndex(38), frameIndex(188)),
        label: 'TITLE',
        enabled: true,
        content: {
          text: 'A rendszer',
          font: 'Inter',
          size: 72,
          weight: 700,
          color: { r: 0.9, g: 0.75, b: 0.49, a: 1 },
          outline: { width: 2, color: { r: 0, g: 0, b: 0, a: 1 } },
          shadow: { offsetX: 0, offsetY: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.5 } },
          align: 'left',
          lineHeight: 1.4,
          letterSpacing: 0.02,
        },
        transform: {
          x: staticNumber(0.1),
          y: staticNumber(0.8),
          scale: staticNumber(1),
          rotation: staticNumber(0),
          opacity: staticNumber(1),
        },
        animateIn: { preset: 'typewriter', durationFrames: 24, ease: 'linear' },
        animateOut: { preset: 'slide', direction: 'up', durationFrames: 12, ease: 'ease-out' },
        reveal: animatedNumber([
          { id: keyframeId('kf6'), frame: frameIndex(0), value: 0, ease: 'linear' },
          { id: keyframeId('kf7'), frame: frameIndex(24), value: 1, ease: 'linear' },
        ]),
        effects: [],
      },
    ],
  };

  return {
    ...base,
    sequence: {
      id: sequenceId('s1'),
      tracks: [videoTrack, audioTrack, textTrack],
      workRange: spanFromBounds(frameIndex(902), frameIndex(1388)),
      markers: [
        { frame: frameIndex(100), label: 'beat', color: '#4c9aff' },
        { frame: frameIndex(500), label: '' },
      ],
    },
    masks: [
      {
        id: maskId('m1'),
        clip: clipId('c1'),
        span: spanFromBounds(frameIndex(10), frameIndex(150)),
        asset: assetPath('masks/m1'),
        points: [
          { frame: frameIndex(12), x: 0.5, y: 0.4, include: true },
          { frame: frameIndex(12), x: 0.1, y: 0.1, include: false },
        ],
      },
    ],
    // Two beats, per issue #33: one carrying every field and one carrying only what a freshly dropped
    // beat has, because both shapes have to survive a save and the second is the common one.
    story: [
      {
        id: storyBeatId('b1'),
        span: spanFromBounds(frameIndex(0), frameIndex(90)),
        title: 'Wide establishing shot',
        notes: '# The dune\n\nThe rider crests it, engine roaring.',
        references: [
          { asset: assetPath('media/frame.png'), note: 'the light in this' },
          { asset: assetPath('media/interview_a.mp4') },
        ],
        accent: 3,
      },
      {
        id: storyBeatId('b2'),
        span: spanFromBounds(frameIndex(90), frameIndex(180)),
        title: '',
        notes: '',
        references: [],
      },
    ],
  };
}
