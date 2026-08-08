/**
 * Visual harness for the component library.
 *
 * Renders components against representative data in a real browser, so layout, typography and the
 * token palette can be inspected and screenshotted. jsdom verifies behaviour and accessibility but
 * computes no layout, so it cannot catch a collapsed flex column, a clip drawn at the wrong offset,
 * or an unreadable contrast pair.
 *
 * Not shipped: this exists for development and for the screenshot checks recorded in the ledger.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type AudioTrack,
  type Clip,
  type TextTrack,
  type TimelineDocument,
  type VideoTrack,
  FRAME_RATES,
  assetPath,
  clipId,
  createDocument,
  effectId,
  effectInstanceId,
  frameIndex,
  generatorId,
  jobRunId,
  maskId,
  projectId,
  sequenceId,
  spanFromBounds,
  staticNumber,
  trackId,
} from '@nos/core';
import { type FileEntry, buildTree } from '@nos/media';
import {
  AssetDetail,
  MediaBrowser,
  Timeline,
  createViewport,
  token,
  zoomAt,
} from '../src/index.js';
import '../src/tokens/tokens.css';

const file = (path: string, sizeBytes: number): FileEntry => ({
  path: assetPath(path),
  sizeBytes,
  isDirectory: false,
});
const dir = (path: string): FileEntry => ({ path: assetPath(path), sizeBytes: 0, isDirectory: true });

const tree = buildTree([
  file('project.json', 4096),
  file('media/interview_a.mp4', 1_400_000_000),
  file('media/interview_b.mp4', 1_200_000_000),
  file('media/broll_city.mov', 480_000_000),
  file('media/room_tone.wav', 21_000_000),
  file('generated/t2v_0117_seed4471.mp4', 1_800_000_000),
  file('generated/bed_0031_seed881.flac', 310_000_000),
  dir('masks'),
  file('masks/seq_01/0001.png', 1024),
  dir('effects'),
  file('effects/film_grain.frag', 900),
  dir('generators'),
  file('generators/stable_audio_3.json', 4000),
  file('notes/treatment.md', 2400),
  dir('renders'),
  dir('cache'),
  file('cache/proxy_1080p30q23_9f3c1a27b4e8d016.mp4', 2_588_490_240),
]);

const transform = {
  x: staticNumber(0),
  y: staticNumber(0),
  scale: staticNumber(1),
  rotation: staticNumber(0),
  opacity: staticNumber(1),
};

function video(id: string, start: number, end: number, label: string, extra: Partial<Clip> = {}): Clip {
  return {
    kind: 'video',
    id: clipId(id),
    span: spanFromBounds(frameIndex(start), frameIndex(end)),
    label,
    enabled: true,
    effects: [],
    source: {
      asset: assetPath(`media/${id}.mp4`),
      sourceIn: frameIndex(0),
      sourceRate: FRAME_RATES.NTSC_29_97,
    },
    transform,
    speed: { factor: 1, preservePitch: true },
    ...extra,
  } as Clip;
}

/** The cut from mockup 1a, at 29.97. */
function sampleDocument(): TimelineDocument {
  const base = createDocument({
    id: projectId('p1'),
    sequenceId: sequenceId('s1'),
    name: 'breakdown_v3',
    frameRate: FRAME_RATES.NTSC_29_97,
    resolution: { width: 1920, height: 1080 },
    trackIds: { video: trackId('v1'), audio: trackId('a1'), text: trackId('t1') },
  });

  const v2: VideoTrack = {
    ...(base.sequence.tracks[0] as VideoTrack),
    id: trackId('v2'),
    name: 'V2',
    height: 64,
    clips: [
      video('broll_city_04', 640, 1170, 'broll_city · 04'),
      video('t2v_0117', 1195, 1590, 't2v_0117', {
        provenance: {
          generator: generatorId('minimax_h3_t2v'),
          run: jobRunId('run_0117'),
          seed: 4471,
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      }),
      video('interview_b_02', 2845, 3470, 'interview_b · 02'),
    ] as VideoTrack['clips'],
  };

  const v1: VideoTrack = {
    ...(base.sequence.tracks[0] as VideoTrack),
    height: 84,
    clips: [
      video('interview_a_01', 0, 590, 'interview_a · 01'),
      video('broll_city_03', 700, 1610, 'broll_city · 03', {
        effects: [
          {
            id: effectInstanceId('fx1'),
            effect: effectId('film_grain'),
            enabled: true,
            params: {},
            mask: maskId('m1'),
          },
          { id: effectInstanceId('fx2'), effect: effectId('rgb_split'), enabled: true, params: {} },
          { id: effectInstanceId('fx3'), effect: effectId('levels'), enabled: true, params: {} },
        ],
      }),
      video('interview_a_02', 1630, 2320, 'interview_a · 02'),
      video('i2v_0104', 2350, 2800, 'i2v_0104', {
        provenance: {
          generator: generatorId('minimax_h3_i2v'),
          run: jobRunId('run_0104'),
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      }),
      video('broll_city_05', 2820, 3690, 'broll_city · 05'),
    ] as VideoTrack['clips'],
  };

  const a1: AudioTrack = {
    ...(base.sequence.tracks[1] as AudioTrack),
    name: 'A1 · voice',
    height: 60,
    clips: [
      {
        kind: 'audio',
        id: clipId('voice_a'),
        span: spanFromBounds(frameIndex(0), frameIndex(1600)),
        label: 'interview_a · voice',
        enabled: true,
        effects: [],
        source: {
          asset: assetPath('media/interview_a.mp4'),
          sourceIn: frameIndex(0),
          sourceRate: FRAME_RATES.NTSC_29_97,
        },
        speed: { factor: 1, preservePitch: true },
        gain: staticNumber(1),
        pan: staticNumber(0),
      },
      {
        kind: 'audio',
        id: clipId('tts_12'),
        span: spanFromBounds(frameIndex(1630), frameIndex(2200)),
        label: 'tts · line 12',
        enabled: true,
        effects: [],
        source: {
          asset: assetPath('generated/tts_12.flac'),
          sourceIn: frameIndex(0),
          sourceRate: FRAME_RATES.NTSC_29_97,
        },
        speed: { factor: 1, preservePitch: true },
        gain: staticNumber(1),
        pan: staticNumber(0),
        provenance: {
          generator: generatorId('tts'),
          run: jobRunId('run_tts_12'),
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      },
    ] as AudioTrack['clips'],
  };

  const a2: AudioTrack = {
    ...a1,
    id: trackId('a2'),
    name: 'A2 · music',
    height: 52,
    clips: [
      {
        ...(a1.clips[1] as AudioTrack['clips'][number]),
        id: clipId('bed_0031'),
        span: spanFromBounds(frameIndex(0), frameIndex(4480)),
        label: 'bed_0031 · seed 881 · flac',
        provenance: {
          generator: generatorId('stable_audio_3'),
          run: jobRunId('run_0031'),
          seed: 881,
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      },
    ] as AudioTrack['clips'],
  };

  const t1: TextTrack = {
    ...(base.sequence.tracks[2] as TextTrack),
    name: 'T1 · text',
    height: 46,
    clips: [
      {
        kind: 'text',
        id: clipId('title'),
        span: spanFromBounds(frameIndex(100), frameIndex(560)),
        label: 'TITLE · typewriter',
        enabled: true,
        effects: [],
        content: {
          text: 'A rendszer',
          font: 'Inter',
          size: 72,
          weight: 700,
          color: { r: 1, g: 1, b: 1, a: 1 },
          align: 'left',
          lineHeight: 1.2,
          letterSpacing: 0,
        },
        transform,
      },
      {
        kind: 'text',
        id: clipId('lower_third'),
        span: spanFromBounds(frameIndex(1180), frameIndex(1770)),
        label: 'LOWER THIRD · fade',
        enabled: true,
        effects: [],
        content: {
          text: 'Lower third',
          font: 'Inter',
          size: 48,
          weight: 600,
          color: { r: 1, g: 1, b: 1, a: 1 },
          align: 'left',
          lineHeight: 1.2,
          letterSpacing: 0,
        },
        transform,
      },
    ] as TextTrack['clips'],
  };

  return { ...base, sequence: { ...base.sequence, tracks: [v2, v1, a1, a2, t1] } };
}

function App() {
  const document = sampleDocument();
  const [viewport, setViewport] = useState(() =>
    createViewport({ framesPerPixel: 3, widthPx: 1150, frameRate: document.frameRate }),
  );
  const [playhead, setPlayhead] = useState(frameIndex(1042));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(['broll_city_03']));
  const [snap, setSnap] = useState(true);
  const [ripple, setRipple] = useState(false);

  return (
    <div className="nos-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <MediaBrowser
          tree={tree}
          watcher={{ watching: true }}
          selected={assetPath('media/broll_city.mov')}
          detail={
            <AssetDetail
              name="broll_city.mov"
              summary="1920×1080 · 29.97 · 00:00:42:11"
              hash="9f3c1a27b4e8d016"
              hasProxy
              hasFilmstrip
            />
          }
        />
        <div style={{ flex: 1, background: token.bgCanvas }} />
      </div>
      <Timeline
        document={document}
        viewport={viewport}
        playhead={playhead}
        selectedClips={selected}
        snapEnabled={snap}
        rippleEnabled={ripple}
        onScrub={setPlayhead}
        onSelectClip={(clip) => setSelected(new Set([clip]))}
        onToggleSnap={() => setSnap((value) => !value)}
        onToggleRipple={() => setRipple((value) => !value)}
        onZoom={(next, anchorPx) => setViewport((vp) => zoomAt(vp, anchorPx, next))}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
